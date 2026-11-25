import type { Clock } from '../lib/clock';
import { dockGeometry, EXPANDED, planResize, sameGeometry } from '../lib/geometry';
import { messageOf, omitUndefined } from '../lib/json';
import type { AppMode } from '../lib/mode';
import type { Cue } from '../lib/sound';
import { applySlotState, focusOf, newlyReady, sortSlots } from '../lib/slots';
import { setCompleted, stepQuota as stepTaskQuota, toggleItem as toggleTaskItem } from '../lib/tasks';
import { periodKeyOf, type ReminderStarts, trackReminders } from '../lib/time';
import type { Bridge } from '../rpc/bridge';
import {
  DEFAULT_SETTINGS,
  type DockGeometry,
  type Note,
  type NoteListInput,
  type Settings,
  type Task,
  type TaskCreateInput,
  type TaskItemInput,
  type TaskList,
  type TaskUpdateInput,
  type ThemeMode,
  type WorkbenchCreateInput,
  type WorkbenchUpdateInput,
  type WorkSlot,
  type WorkSlotState,
} from '../rpc/types';

export type NotesScope = 'all' | 'focus';
export type ThemeChoice = ThemeMode | 'system';

export interface UiState {
  expanded: boolean;
  /** the slot a double-click in the tray asked to see */
  highlightSlotId: string | null;
  selectedTaskId: string | null;
  notesScope: NotesScope;
  notesQuery: string;
  /** follow the desktop's light or dark; the contract's ThemeMode has no such value, so it stays on this side */
  followSystem: boolean;
  systemDark: boolean;
  /** bumped to ask a component to take the keyboard */
  newSlotSignal: number;
  composeSignal: number;
  searchSignal: number;
  notice: string | null;
}

export interface AppState {
  ready: boolean;
  slots: WorkSlot[];
  periodKey: string;
  tasks: Task[];
  notes: Note[];
  settings: Settings;
  reminders: ReminderStarts;
  ui: UiState;
}

/** UI choices kept on this side, in localStorage. */
export interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFS_KEY = 'featherlog.ui.v2';
const NOTICE_MS = 4000;
const QUERY_DEBOUNCE_MS = 160;

interface Prefs {
  notesScope: NotesScope;
  followSystem: boolean;
}

function readPrefs(storage: PrefStorage | null): Partial<Prefs> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
  } catch {
    return {};
  }
}

export interface StoreDeps {
  bridge: Bridge;
  clock: Clock;
  prefs?: PrefStorage | null;
  sound?: (cue: Cue, settings: Settings) => void;
  /** collapse when the window loses focus (unpinned); on by default inside a host */
  collapseOnBlur?: boolean;
  /** "panel" inside the MyGo popup window, "dock" in a browser tab (the default) */
  mode?: AppMode;
}

/** A blur right after Esc or the collapse button is the same request: send one. */
const HIDE_DEBOUNCE_MS = 500;

export class AppStore {
  readonly bridge: Bridge;
  readonly clock: Clock;
  readonly collapseOnBlur: boolean;
  /** Always the drawer; "collapsing" asks the host to hide its window. */
  readonly panel: boolean;
  #state: AppState;
  readonly #listeners = new Set<() => void>();
  readonly #prefs: PrefStorage | null;
  readonly #sound: StoreDeps['sound'];
  #off: Array<() => void> = [];
  #timers: Array<() => void> = [];
  #cancelQuery: (() => void) | null = null;
  #cancelNotice: (() => void) | null = null;
  #notesReq = 0;
  #lastGeom: DockGeometry | null = null;
  #lastHideAt = Number.NEGATIVE_INFINITY;
  #started = false;

  constructor(deps: StoreDeps) {
    this.bridge = deps.bridge;
    this.clock = deps.clock;
    this.#prefs = deps.prefs ?? null;
    this.#sound = deps.sound;
    this.collapseOnBlur = deps.collapseOnBlur ?? deps.bridge.kind === 'mygo';
    this.panel = deps.mode === 'panel';
    const prefs = readPrefs(this.#prefs);
    this.#state = {
      ready: false,
      slots: [],
      periodKey: periodKeyOf(deps.clock.now(), DEFAULT_SETTINGS.dayStartHour),
      tasks: [],
      notes: [],
      settings: { ...DEFAULT_SETTINGS },
      reminders: {},
      ui: {
        expanded: this.panel,
        highlightSlotId: null,
        selectedTaskId: null,
        notesScope: prefs.notesScope ?? 'all',
        notesQuery: '',
        followSystem: prefs.followSystem ?? false,
        systemDark: false,
        newSlotSignal: 0,
        composeSignal: 0,
        searchSignal: 0,
        notice: null,
      },
    };
  }

  getState = (): AppState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async init(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const b = this.bridge;
    this.#off.push(
      b.on('workbench:changed', (slots) => this.#applySlots(slots, true)),
      b.on('tasks:changed', (list) => this.#applyTaskList(list)),
      b.on('notes:changed', () => void this.refreshNotes()),
      b.on('settings:changed', (settings) => this.#applySettings(settings)),
      // In panel mode the host shows and hides its window itself and then says so; there is nothing to echo.
      b.on('dock:toggle', ({ expanded }) => {
        if (!this.panel) this.setExpanded(expanded ?? !this.#state.ui.expanded);
      }),
    );
    try {
      const [slots, taskList, settings] = await Promise.all([b.workbench.list(), b.tasks.list(), b.settings.get()]);
      const now = this.clock.now();
      const sorted = sortSlots(slots);
      this.#set({
        ready: true,
        slots: sorted,
        reminders: trackReminders({}, sorted, now, true),
        periodKey: taskList.periodKey,
        tasks: taskList.tasks,
        settings,
      });
    } catch (err) {
      this.#set({ ready: true });
      this.#notice(`连接后端失败：${messageOf(err)}`);
    }
    await this.refreshNotes();
    this.#syncDock();
  }

  dispose(): void {
    for (const off of this.#off) off();
    for (const cancel of this.#timers) cancel();
    this.#cancelQuery?.();
    this.#cancelNotice?.();
    this.#off = [];
    this.#timers = [];
    this.#started = false;
  }

  // ---- expansion & window ----

  setExpanded(expanded: boolean, options: { highlightSlotId?: string } = {}): void {
    if (this.panel) {
      // The view stays the drawer, so the next click on the Plasmoid shows it at once.
      if (expanded) {
        if (options.highlightSlotId) this.#setUi({ highlightSlotId: options.highlightSlotId }, false);
      } else {
        this.#requestHide();
      }
      return;
    }
    const was = this.#state.ui.expanded;
    this.#setUi({
      expanded,
      highlightSlotId: expanded ? (options.highlightSlotId ?? this.#state.ui.highlightSlotId) : null,
    });
    if (was !== expanded) this.#cue(expanded ? 'lift' : 'settle');
    this.#syncDock();
  }

  toggleExpanded(): void {
    this.setExpanded(!this.#state.ui.expanded);
  }

  /** Escape and blur: back to the bar (or, in panel mode, hide the window) unless pinned. */
  collapseIfUnpinned(): boolean {
    if (!this.#state.ui.expanded || this.#state.settings.pinned) return false;
    this.setExpanded(false);
    return true;
  }

  clearHighlight(): void {
    if (this.#state.ui.highlightSlotId) this.#setUi({ highlightSlotId: null }, false);
  }

  requestNewSlot(): void {
    this.setExpanded(true);
    this.#setUi({ newSlotSignal: this.#state.ui.newSlotSignal + 1 }, false);
  }

  requestCompose(): void {
    this.setExpanded(true);
    this.#setUi({ composeSignal: this.#state.ui.composeSignal + 1 }, false);
  }

  requestSearch(): void {
    this.setExpanded(true);
    this.#setUi({ searchSignal: this.#state.ui.searchSignal + 1 }, false);
  }

  openTasks(): void {
    this.setExpanded(true);
  }

  async quit(): Promise<void> {
    await this.#run('退出', () => this.bridge.dock.quit());
  }

  // ---- work slots ----

  async createSlot(input: WorkbenchCreateInput): Promise<WorkSlot | undefined> {
    const title = input.title.trim();
    if (!title) return undefined;
    const created = await this.#run('新建并发槽', () =>
      this.bridge.workbench.create(omitUndefined({ ...input, title, state: input.state ?? 'focus' })),
    );
    if (!created) return undefined;
    // Creating a focus slot demotes the old one: only the list says so.
    const slots = await this.#run('刷新并发槽', () => this.bridge.workbench.list());
    this.#applySlots(slots ?? [...this.#state.slots, created], false);
    this.#cue('lift');
    return created;
  }

  async updateSlot(input: WorkbenchUpdateInput): Promise<void> {
    const prev = this.#state.slots;
    // Text edits show at once; the reply or an error settles them.
    this.#set({ slots: prev.map((s) => (s.id === input.id ? patchSlot(s, input) : s)) });
    const slot = await this.#run('保存', () => this.bridge.workbench.update(input));
    if (slot) this.#set({ slots: this.#state.slots.map((s) => (s.id === slot.id ? slot : s)) });
    else this.#set({ slots: prev });
  }

  async setSlotState(id: string, state: WorkSlotState, remindInMinutes?: number | null): Promise<void> {
    const prev = this.#state.slots;
    const target = prev.find((s) => s.id === id);
    if (!target) return;
    try {
      this.#applySlots(applySlotState(prev, id, state, this.clock.now(), remindInMinutes), false);
    } catch {
      return;
    }
    this.#cue(state === 'focus' ? 'lift' : state === 'ready' ? 'tap' : 'settle');
    const input = omitUndefined({ id, state, remindInMinutes });
    const slots = await this.#run('切换状态', () => this.bridge.workbench.setState(input));
    this.#applySlots(slots ?? prev, false);
  }

  /** Alt+1..9 and a click in the tray. */
  async focusSlotAt(index: number): Promise<void> {
    const slot = this.#state.slots[index];
    if (slot && slot.state !== 'focus') await this.setSlotState(slot.id, 'focus');
  }

  async completeSlot(id: string, completeLinkedTask = false): Promise<void> {
    const prev = this.#state.slots;
    this.#applySlots(prev.filter((s) => s.id !== id), false);
    this.#cue('done');
    const slots = await this.#run('完成下台', () => this.bridge.workbench.complete(omitUndefined({ id, completeLinkedTask })));
    this.#applySlots(slots ?? prev, false);
    if (slots && completeLinkedTask) await this.refreshTasks();
  }

  async reorderSlots(ids: string[]): Promise<void> {
    const slots = await this.#run('排序', () => this.bridge.workbench.reorder({ ids }));
    if (slots) this.#applySlots(slots, false);
  }

  /** "上台 ↗": a task becomes the slot in focus, reusing a slot already tied to it. */
  async promoteTask(taskId: string): Promise<void> {
    const task = this.#state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const existing = this.#state.slots.find((s) => s.linkedTaskId === taskId);
    if (existing) {
      if (existing.state !== 'focus') await this.setSlotState(existing.id, 'focus');
      this.#setUi({ highlightSlotId: existing.id }, false);
      return;
    }
    const slot = await this.createSlot({ title: task.title, linkedTaskId: task.id, state: 'focus' });
    if (slot) this.#setUi({ highlightSlotId: slot.id }, false);
  }

  // ---- tasks ----

  async refreshTasks(): Promise<void> {
    const list = await this.#run('刷新任务', () => this.bridge.tasks.list());
    if (list) this.#applyTaskList(list);
  }

  async createTask(input: TaskCreateInput): Promise<Task | undefined> {
    if (!input.title.trim()) return undefined;
    const task = await this.#run('新建任务', () => this.bridge.tasks.create(omitUndefined({ ...input, title: input.title.trim() })));
    if (task) {
      this.#upsertTask(task);
      this.#cue('tap');
    }
    return task;
  }

  async updateTask(input: TaskUpdateInput): Promise<void> {
    const task = await this.#run('保存任务', () => this.bridge.tasks.update(omitUndefined(input)));
    if (task) this.#upsertTask(task);
  }

  async setItems(id: string, items: TaskItemInput[]): Promise<void> {
    const task = await this.#run('保存子项', () => this.bridge.tasks.setItems({ id, items: items.map((i) => omitUndefined(i)) }));
    if (task) this.#upsertTask(task);
  }

  async toggleItem(taskId: string, itemId: string, done?: boolean): Promise<void> {
    await this.#optimisticTask(taskId, (t) => toggleTaskItem(t, itemId, done), '勾选', () =>
      this.bridge.tasks.toggleItem(omitUndefined({ taskId, itemId, done })),
    );
    this.#cue('tap');
  }

  async stepQuota(id: string, delta: 1 | -1, itemId?: string): Promise<void> {
    const before = this.#state.tasks.find((t) => t.id === id);
    await this.#optimisticTask(id, (t) => stepTaskQuota(t, delta, itemId, this.clock.now()), '计数', () =>
      this.bridge.tasks.stepQuota(omitUndefined({ id, itemId, delta })),
    );
    const after = this.#state.tasks.find((t) => t.id === id);
    this.#cue(before?.status !== 'completed' && after?.status === 'completed' ? 'done' : 'tap');
  }

  async completeTask(id: string, completed: boolean): Promise<void> {
    await this.#optimisticTask(id, (t) => setCompleted(t, completed, this.clock.now()), '完成任务', () =>
      this.bridge.tasks.complete({ id, completed }),
    );
    this.#cue(completed ? 'done' : 'tap');
  }

  async deleteTask(id: string): Promise<void> {
    const ok = await this.#run('删除任务', () => this.bridge.tasks.delete({ id }));
    if (ok === undefined) return;
    this.#set({ tasks: this.#state.tasks.filter((t) => t.id !== id) });
    if (this.#state.ui.selectedTaskId === id) this.selectTask(null);
  }

  /**
   * Toggle 每日重置 in place via TaskService.Update: setting recurrence promotes
   * any task to daily rollover, and passing recurrence: null returns it to a
   * plain todo while preserving id, items, quota, completion, linked slots and notes.
   */
  async setDailyReset(id: string, daily: boolean): Promise<void> {
    const old = this.#state.tasks.find((t) => t.id === id);
    if (!old || (old.kind === 'daily') === daily) return;
    const input: TaskUpdateInput = daily
      ? { id, recurrence: { freq: 'daily' }, ...(old.deadline ? { deadline: null } : {}) }
      : { id, recurrence: null };
    const task = await this.#run('切换每日重置', () => this.bridge.tasks.update(input));
    if (task) this.#upsertTask(task);
  }

  selectTask(id: string | null): void {
    if (this.#state.ui.selectedTaskId === id) return;
    this.#setUi({ selectedTaskId: id }, false);
    if (this.#state.ui.notesScope === 'focus') void this.refreshNotes();
  }

  // ---- notes ----

  /** The task the focus notes hang on: the picked task, else the focus slot's. */
  notesContextTaskId(state: AppState = this.#state): string | null {
    if (state.ui.selectedTaskId && state.tasks.some((t) => t.id === state.ui.selectedTaskId)) return state.ui.selectedTaskId;
    return focusOf(state.slots)?.linkedTaskId ?? null;
  }

  notesFilter(state: AppState = this.#state): NoteListInput | null {
    const query = state.ui.notesQuery.trim();
    const q = query ? { query } : {};
    if (state.ui.notesScope === 'all') return q;
    const taskId = this.notesContextTaskId(state);
    return taskId ? { taskId, ...q } : null;
  }

  async refreshNotes(): Promise<void> {
    const req = ++this.#notesReq;
    const filter = this.notesFilter();
    if (!filter) {
      this.#set({ notes: [] });
      return;
    }
    const notes = await this.#run('读取随笔', () => this.bridge.notes.list(filter));
    // A slower, older request must not overwrite a newer filter's answer.
    if (notes && req === this.#notesReq) this.#set({ notes });
  }

  setNotesScope(notesScope: NotesScope): void {
    if (this.#state.ui.notesScope === notesScope) return;
    this.#setUi({ notesScope });
    void this.refreshNotes();
  }

  setNotesQuery(notesQuery: string): void {
    this.#setUi({ notesQuery }, false);
    this.#cancelQuery?.();
    this.#cancelQuery = this.clock.setTimeout(() => {
      this.#cancelQuery = null;
      void this.refreshNotes();
    }, QUERY_DEBOUNCE_MS);
  }

  async createNote(content: string): Promise<boolean> {
    const text = content.trim();
    if (!text) return false;
    const taskId = this.#state.ui.notesScope === 'focus' ? this.notesContextTaskId() : null;
    const note = await this.#run('保存随笔', () => this.bridge.notes.create({ content: text, taskId }));
    if (!note) return false;
    this.#cue('tap');
    await this.refreshNotes();
    return true;
  }

  async updateNote(id: string, content: string): Promise<boolean> {
    const text = content.trim();
    if (!text) return false;
    const note = await this.#run('保存随笔', () => this.bridge.notes.update({ id, content: text }));
    if (!note) return false;
    this.#set({ notes: this.#state.notes.map((n) => (n.id === id ? note : n)) });
    return true;
  }

  async deleteNote(id: string): Promise<void> {
    const ok = await this.#run('删除随笔', () => this.bridge.notes.delete({ id }));
    if (ok === undefined) return;
    this.#set({ notes: this.#state.notes.filter((n) => n.id !== id) });
  }

  // ---- settings ----

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const prev = this.#state.settings;
    this.#applySettings({ ...prev, ...patch });
    const settings = await this.#run('保存设置', () => this.bridge.settings.update(patch));
    this.#applySettings(settings ?? prev);
  }

  setThemeChoice(choice: ThemeChoice): void {
    this.#setUi({ followSystem: choice === 'system' });
    if (choice !== 'system' && choice !== this.#state.settings.theme) void this.updateSettings({ theme: choice });
  }

  setSystemDark(systemDark: boolean): void {
    if (this.#state.ui.systemDark !== systemDark) this.#setUi({ systemDark }, false);
  }

  async togglePin(): Promise<void> {
    const pinned = !this.#state.settings.pinned;
    this.#cue(pinned ? 'lift' : 'settle');
    await this.updateSettings({ pinned });
  }

  async toggleSound(): Promise<void> {
    const sound = !this.#state.settings.sound;
    await this.updateSettings({ sound });
    this.#cue('tap');
  }

  dismissNotice(): void {
    this.#cancelNotice?.();
    this.#setUi({ notice: null }, false);
  }

  // ---- internals ----

  #set(patch: Partial<AppState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }

  #setUi(patch: Partial<UiState>, persist = true): void {
    this.#set({ ui: { ...this.#state.ui, ...patch } });
    if (persist && this.#prefs) {
      const { notesScope, followSystem } = this.#state.ui;
      try {
        this.#prefs.setItem(PREFS_KEY, JSON.stringify({ notesScope, followSystem }));
      } catch {
        // Preferences are a convenience; a blocked storage loses only them.
      }
    }
  }

  #applySlots(slots: WorkSlot[], fromEvent: boolean): void {
    const prev = this.#state.slots;
    const sorted = sortSlots(slots);
    const focusBefore = focusOf(prev)?.linkedTaskId ?? null;
    this.#set({ slots: sorted, reminders: trackReminders(this.#state.reminders, sorted, this.clock.now(), false) });
    if (fromEvent && newlyReady(prev, sorted).length > 0) this.#cue('ready');
    if (prev.length !== sorted.length) this.#syncDock();
    const focusAfter = focusOf(sorted)?.linkedTaskId ?? null;
    if (focusBefore !== focusAfter && this.#state.ui.notesScope === 'focus' && !this.#state.ui.selectedTaskId) {
      void this.refreshNotes();
    }
  }

  #applyTaskList(list: TaskList): void {
    this.#set({ periodKey: list.periodKey, tasks: list.tasks });
  }

  #applySettings(settings: Settings): void {
    const pinnedChanged = settings.pinned !== this.#state.settings.pinned;
    this.#set({ settings });
    if (pinnedChanged) this.#syncDock();
  }

  #upsertTask(task: Task): void {
    const exists = this.#state.tasks.some((t) => t.id === task.id);
    this.#set({ tasks: exists ? this.#state.tasks.map((t) => (t.id === task.id ? task : t)) : [...this.#state.tasks, task] });
  }

  async #optimisticTask(id: string, local: (t: Task) => Task, label: string, remote: () => Promise<Task>): Promise<void> {
    const before = this.#state.tasks.find((t) => t.id === id);
    if (!before) return;
    try {
      this.#upsertTask(local(before));
    } catch {
      // The backend decides; the local guess only makes the click feel instant.
    }
    const task = await this.#run(label, remote);
    this.#upsertTask(task ?? before);
  }

  async #run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      this.#notice(`${label}失败：${messageOf(err)}`);
      return undefined;
    }
  }

  #notice(text: string): void {
    this.#cancelNotice?.();
    this.#setUi({ notice: text }, false);
    this.#cancelNotice = this.clock.setTimeout(() => {
      this.#cancelNotice = null;
      this.#setUi({ notice: null }, false);
    }, NOTICE_MS);
  }

  #cue(cue: Cue): void {
    this.#sound?.(cue, this.#state.settings);
  }

  /** Panel mode: DockService.Resize with expanded false tells the host to hide the popup. */
  #requestHide(): void {
    const now = this.clock.now();
    if (now - this.#lastHideAt < HIDE_DEBOUNCE_MS) return;
    this.#lastHideAt = now;
    this.#cue('settle');
    const geom: DockGeometry = { width: EXPANDED.width, height: EXPANDED.height, expanded: false, pinned: this.#state.settings.pinned };
    this.bridge.dock.resize(geom).catch((err: unknown) => this.#notice(`收起面板失败：${messageOf(err)}`));
  }

  #syncDock(): void {
    // The popup's size and visibility belong to the host; the page only asks it to hide.
    if (this.panel) return;
    const { ui, slots, settings } = this.#state;
    const next = dockGeometry(ui.expanded, slots.length, settings.pinned);
    if (this.#lastGeom && sameGeometry(this.#lastGeom, next)) return;
    const steps = planResize(this.#lastGeom, next);
    this.#lastGeom = next;
    for (const cancel of this.#timers) cancel();
    this.#timers = [];
    for (const step of steps) {
      const send = (): void => {
        this.bridge.dock.resize(step.geom).catch((err: unknown) => this.#notice(`调整窗口失败：${messageOf(err)}`));
      };
      if (step.delayMs === 0) send();
      else this.#timers.push(this.clock.setTimeout(send, step.delayMs));
    }
  }
}

function patchSlot(slot: WorkSlot, input: WorkbenchUpdateInput): WorkSlot {
  const next: WorkSlot = { ...slot };
  if (input.title !== undefined && input.title.trim()) next.title = input.title.trim();
  if (input.breadcrumb !== undefined) next.breadcrumb = input.breadcrumb.trim();
  if (input.tag !== undefined) next.tag = input.tag.trim() || undefined;
  if (input.linkedTaskId !== undefined) next.linkedTaskId = input.linkedTaskId ?? undefined;
  return omitUndefined(next);
}

/** The theme to paint: the chosen one, or the desktop's under "system". */
export function resolvedTheme(state: AppState): ThemeMode {
  if (state.ui.followSystem) return state.ui.systemDark ? 'graphite' : 'stone';
  return state.settings.theme;
}

export function themeChoiceOf(state: AppState): ThemeChoice {
  return state.ui.followSystem ? 'system' : state.settings.theme;
}
