import { type Clock, systemClock } from '../lib/clock';
import { jsonClone, omitUndefined } from '../lib/json';
import { applySlotState, fireDueReminders, MINUTE_MS, sortSlots } from '../lib/slots';
import { rollDaily, setCompleted, stepQuota, toggleItem, withDue } from '../lib/tasks';
import { addDays, periodKeyOf } from '../lib/time';
import type { Bridge } from './bridge';
import {
  BAR_MODES,
  type BridgeEventName,
  type BridgeEvents,
  DEFAULT_SETTINGS,
  type DockGeometry,
  type DockService,
  type Note,
  type NoteListInput,
  type NoteService,
  type Settings,
  type SettingsService,
  type Task,
  type TaskItem,
  type TaskKind,
  type TaskList,
  type TaskService,
  type WorkbenchService,
  type WorkSlot,
} from './types';

/** localStorage, or anything shaped like it. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MockOptions {
  clock?: Clock;
  /** null keeps everything in memory; omitted uses localStorage when there is one */
  storage?: KeyValueStorage | null;
  storageKey?: string;
  /** false starts empty instead of with the sample slots, tasks and notes */
  seed?: boolean;
}

export interface MockData {
  version: 2;
  seq: number;
  slots: WorkSlot[];
  tasks: Task[];
  notes: Note[];
  settings: Settings;
}

export const MOCK_STORAGE_KEY = 'featherlog.mock.v2';

function safeLocalStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

export function emptyData(): MockData {
  return { version: 2, seq: 0, slots: [], tasks: [], notes: [], settings: { ...DEFAULT_SETTINGS } };
}

/** Three slots of a day with several AI sessions in flight, and the tasks and notes around them. */
export function seedData(now: number, dayStartHour: number = DEFAULT_SETTINGS.dayStartHour): MockData {
  const today = periodKeyOf(now, dayStartHour);
  const ago = (minutes: number): number => now - minutes * MINUTE_MS;
  let order = 0;
  const task = (id: string, kind: TaskKind, title: string, extra: Partial<Task>): Task =>
    withDue(
      omitUndefined({
        id,
        kind,
        title,
        status: 'active' as const,
        items: [],
        dueToday: false,
        overdue: false,
        order: order++,
        createdAt: ago(60 * 24 * 3 - order * 5),
        periodKey: kind === 'daily' ? today : undefined,
        streak: kind === 'daily' ? 0 : undefined,
        ...extra,
      }),
      today,
      dayStartHour,
    );

  // Every todo is an equal, plain one; two of them reset daily, one was finished today.
  const tasks: Task[] = [
    task('t-1', 'side', 'v2 前端：面板模式联调', {
      items: [
        { id: 'i-1', text: '收起态交给 Plasmoid', done: true },
        { id: 'i-2', text: '面板铺满不透明窗口', done: false },
        { id: 'i-3', text: 'Esc / 失焦隐藏弹窗', done: false },
        { id: 'i-4', text: '和 Go 宿主联调 Resize', done: false },
      ],
      scheduledFor: today,
      deadline: addDays(today, 3),
    }),
    task('t-2', 'side', '压测 barhttp 长轮询', { quota: { current: 2, target: 6 }, scheduledFor: today }),
    task('t-3', 'side', '给 clipnest 提 Linux 托盘的 issue', { scheduledFor: today }),
    task('t-4', 'side', '整理 seamline 的 flaky 用例清单', { deadline: addDays(today, -1) }),
    task('t-5', 'side', '补 frontend README 的对接说明', { scheduledFor: today }),
    task('t-6', 'daily', '看一眼夜间构建', { recurrence: { freq: 'daily' }, streak: 4 }),
    task('t-7', 'daily', '过一遍待审 PR', { recurrence: { freq: 'daily' }, quota: { current: 1, target: 3 }, streak: 9 }),
    task('t-8', 'side', '升级 MyGo 到 0.8.3', { scheduledFor: today, status: 'completed', completedAt: ago(40) }),
  ];

  const slots: WorkSlot[] = [
    {
      id: 's-1',
      title: '底部卡槽的展开动画',
      state: 'focus',
      breadcrumb: '收起宽度算法定了，接着调焦点板的弹簧',
      tag: 'Featherlog',
      linkedTaskId: 't-1',
      stateChangedAt: ago(18),
      order: 0,
      createdAt: ago(95),
      updatedAt: ago(18),
    },
    {
      id: 's-2',
      title: 'Claude 在跑 e2e 回归',
      state: 'running',
      breadcrumb: '等 CI 绿了就合 PR #42；挂了先看 login 用例',
      tag: 'seamline',
      stateChangedAt: ago(14),
      remindAt: now + 6 * MINUTE_MS,
      order: 1,
      createdAt: ago(70),
      updatedAt: ago(14),
    },
    {
      id: 's-3',
      title: 'Codex 改完原子存储',
      state: 'ready',
      breadcrumb: '回来审 diff，重点看迁移脚本和 fsync',
      tag: 'PR #42',
      stateChangedAt: ago(3),
      order: 2,
      createdAt: ago(130),
      updatedAt: ago(3),
    },
  ];

  const notes: Note[] = [
    {
      id: 'n-1',
      content: '面板是不透明的 880×520 弹窗：收起只是让宿主把窗口藏起来，视图一直停在工作台，下次点状态栏秒开。',
      taskId: 't-1',
      createdAt: ago(50),
      updatedAt: ago(50),
    },
    {
      id: 'n-2',
      content: '底部卡槽像一摞索引卡：抽出来的那张是手上正在做的，其余的安静插在槽里。',
      taskId: null,
      createdAt: ago(120),
      updatedAt: ago(120),
    },
    {
      id: 'n-3',
      content: '第 2 轮：200 个长轮询连接，唤醒延迟都在 5ms 内，内存平稳。',
      taskId: 't-2',
      createdAt: ago(180),
      updatedAt: ago(180),
    },
    {
      id: 'n-4',
      content: 'AI 跑测试的空档别去刷手机，回卡槽扫一眼哪张写着「待看」。',
      taskId: null,
      createdAt: ago(60 * 26),
      updatedAt: ago(60 * 26),
    },
  ];

  return { version: 2, seq: 100, slots, tasks, notes, settings: { ...DEFAULT_SETTINGS, dayStartHour } };
}

type Listener = (payload: unknown) => void;

/**
 * The backend in a browser tab: the same services and events as the Go side,
 * kept in localStorage, so the frontend runs, previews and tests on its own.
 */
export class LocalMockBridge implements Bridge {
  readonly kind = 'mock' as const;
  readonly workbench: WorkbenchService;
  readonly tasks: TaskService;
  readonly notes: NoteService;
  readonly settings: SettingsService;
  readonly dock: DockService;
  /** The last geometry the page asked the dock for. */
  lastGeometry: DockGeometry | null = null;
  quitRequested = false;
  /** Whether the host's workbench window would be showing now. */
  panelOpen = false;

  readonly #clock: Clock;
  readonly #storage: KeyValueStorage | null;
  readonly #key: string;
  readonly #listeners = new Map<string, Set<Listener>>();
  #data: MockData;
  #period: string;
  #stopTicker: () => void;

  constructor(options: MockOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#storage = options.storage === undefined ? safeLocalStorage() : options.storage;
    this.#key = options.storageKey ?? MOCK_STORAGE_KEY;
    this.#data = this.#load() ?? (options.seed === false ? emptyData() : seedData(this.#clock.now()));
    this.#period = this.#periodKey();
    this.#rollTasks();
    this.#fireReminders();
    this.#save();
    this.#stopTicker = this.#clock.setInterval(() => this.#tick(), 1000);

    this.workbench = {
      list: () => this.#reply(() => sortSlots(this.#data.slots)),
      create: (input) =>
        this.#reply(() => {
          const title = input.title.trim();
          if (!title) fail('workbench/title-required');
          if (input.linkedTaskId && !this.#task(input.linkedTaskId, false)) fail('workbench/task-not-found', input.linkedTaskId);
          const now = this.#clock.now();
          const state = input.state ?? 'running';
          const slot: WorkSlot = omitUndefined({
            id: this.#id('s'),
            title,
            state: 'running' as const,
            breadcrumb: input.breadcrumb?.trim() ?? '',
            tag: input.tag?.trim() || undefined,
            linkedTaskId: input.linkedTaskId,
            stateChangedAt: now,
            order: Math.max(-1, ...this.#data.slots.map((s) => s.order)) + 1,
            createdAt: now,
            updatedAt: now,
          });
          this.#data.slots = applySlotState([...this.#data.slots, slot], slot.id, state, now);
          this.#emitSlots();
          return this.#slot(slot.id);
        }),
      update: (input) =>
        this.#reply(() => {
          const slot = this.#slot(input.id);
          const next: WorkSlot = { ...slot, updatedAt: this.#clock.now() };
          if (input.title !== undefined) {
            const title = input.title.trim();
            if (!title) fail('workbench/title-required');
            next.title = title;
          }
          if (input.breadcrumb !== undefined) next.breadcrumb = input.breadcrumb.trim();
          if (input.tag !== undefined) next.tag = input.tag.trim() || undefined;
          if (input.linkedTaskId === null) next.linkedTaskId = undefined;
          else if (input.linkedTaskId !== undefined) {
            this.#task(input.linkedTaskId);
            next.linkedTaskId = input.linkedTaskId;
          }
          this.#replaceSlot(omitUndefined(next));
          this.#emitSlots();
          return this.#slot(slot.id);
        }),
      setState: (input) =>
        this.#reply(() => {
          this.#data.slots = applySlotState(this.#data.slots, input.id, input.state, this.#clock.now(), input.remindInMinutes);
          this.#emitSlots();
          return sortSlots(this.#data.slots);
        }),
      complete: (input) =>
        this.#reply(() => {
          const slot = this.#slot(input.id);
          this.#data.slots = this.#data.slots.filter((s) => s.id !== slot.id);
          if (input.completeLinkedTask && slot.linkedTaskId) {
            const task = this.#task(slot.linkedTaskId, false);
            if (task) {
              this.#replaceTask(setCompleted(task, true, this.#clock.now()));
              this.#emitTasks();
            }
          }
          this.#emitSlots();
          return sortSlots(this.#data.slots);
        }),
      reorder: (input) =>
        this.#reply(() => {
          const rank = new Map(input.ids.map((id, i) => [id, i]));
          const rest = sortSlots(this.#data.slots.filter((s) => !rank.has(s.id)));
          this.#data.slots = this.#data.slots.map((s) => ({
            ...s,
            order: rank.get(s.id) ?? input.ids.length + rest.indexOf(s),
          }));
          this.#emitSlots();
          return sortSlots(this.#data.slots);
        }),
    };

    this.tasks = {
      list: () => this.#reply(() => this.#taskList()),
      create: (input) =>
        this.#reply(() => {
          const title = input.title.trim();
          if (!title) fail('task/title-required');
          const now = this.#clock.now();
          const rawKind = input.kind;
          const kind: TaskKind =
            input.recurrence != null ? 'daily' : rawKind == null || rawKind === 'task' ? 'side' : rawKind;
          const daily = kind === 'daily';
          const target = input.quotaTarget != null && input.quotaTarget > 0 ? Math.floor(input.quotaTarget) : undefined;
          const task: Task = omitUndefined({
            id: this.#id('t'),
            kind,
            title,
            status: 'active' as const,
            items: (input.items ?? []).filter((i) => i.text.trim()).map((i) => this.#newItem(i.text, i.target)),
            quota: target ? { current: 0, target } : undefined,
            recurrence: daily ? (input.recurrence ?? { freq: 'daily' as const }) : undefined,
            periodKey: daily ? this.#period : undefined,
            streak: daily ? 0 : undefined,
            deadline: input.deadline,
            scheduledFor: input.scheduledFor,
            dueToday: false,
            overdue: false,
            order: Math.max(-1, ...this.#data.tasks.map((t) => t.order)) + 1,
            createdAt: now,
          });
          this.#data.tasks.push(this.#due(task));
          this.#emitTasks();
          return this.#task(task.id);
        }),
      update: (input) =>
        this.#reply(() => {
          let task = this.#task(input.id);
          const now = this.#clock.now();
          if (input.title !== undefined) {
            const title = input.title.trim();
            if (!title) fail('task/title-required');
            task = { ...task, title };
          }
          if (input.recurrence === null) {
            task = omitUndefined({
              ...task,
              kind: 'side' as const,
              recurrence: undefined,
              periodKey: undefined,
              streak: undefined,
            });
          } else if (input.recurrence !== undefined) {
            const wasDaily = task.kind === 'daily';
            const completedToday =
              task.status === 'completed' &&
              task.completedAt != null &&
              periodKeyOf(task.completedAt, this.#data.settings.dayStartHour) === this.#period;
            task = {
              ...task,
              kind: 'daily' as const,
              recurrence: input.recurrence,
              periodKey: this.#period,
              streak: wasDaily ? (task.streak ?? 0) : completedToday ? 1 : 0,
            };
          }
          if (input.quotaTarget === null) task = { ...task, quota: undefined };
          else if (input.quotaTarget !== undefined && input.quotaTarget > 0) {
            const target = Math.floor(input.quotaTarget);
            task = { ...task, quota: { target, current: Math.min(task.quota?.current ?? 0, target) } };
          }
          if (input.deadline !== undefined) task = { ...task, deadline: input.deadline ?? undefined };
          if (input.scheduledFor !== undefined) task = { ...task, scheduledFor: input.scheduledFor ?? undefined };
          if (input.status === 'completed' || input.status === 'active') task = setCompleted(task, input.status === 'completed', now);
          else if (input.status === 'archived') task = { ...task, status: 'archived' };
          this.#replaceTask(omitUndefined(task));
          this.#emitTasks();
          return this.#task(task.id);
        }),
      setItems: (input) =>
        this.#reply(() => {
          const task = this.#task(input.id);
          const existing = new Map(task.items.map((i) => [i.id, i]));
          const items = input.items
            .filter((i) => i.text.trim())
            .map((i): TaskItem => {
              const base = (i.id && existing.get(i.id)) || this.#newItem(i.text, i.target);
              return omitUndefined({
                ...base,
                text: i.text.trim(),
                done: i.done ?? base.done,
                current: i.current ?? base.current,
                target: i.target ?? base.target,
              });
            });
          this.#replaceTask({ ...task, items });
          this.#emitTasks();
          return this.#task(task.id);
        }),
      toggleItem: (input) =>
        this.#reply(() => {
          this.#replaceTask(toggleItem(this.#task(input.taskId), input.itemId, input.done));
          this.#emitTasks();
          return this.#task(input.taskId);
        }),
      stepQuota: (input) =>
        this.#reply(() => {
          if (input.delta === 0) fail('task/zero-step');
          this.#replaceTask(stepQuota(this.#task(input.id), input.delta, input.itemId, this.#clock.now()));
          this.#emitTasks();
          return this.#task(input.id);
        }),
      complete: (input) =>
        this.#reply(() => {
          this.#replaceTask(setCompleted(this.#task(input.id), input.completed, this.#clock.now()));
          this.#emitTasks();
          return this.#task(input.id);
        }),
      delete: (input) =>
        this.#reply(() => {
          this.#task(input.id);
          this.#data.tasks = this.#data.tasks.filter((t) => t.id !== input.id);
          // Notes and slots outlive the task: they let go of it.
          if (this.#data.notes.some((n) => n.taskId === input.id)) {
            this.#data.notes = this.#data.notes.map((n) => (n.taskId === input.id ? { ...n, taskId: null } : n));
            this.#emit('notes:changed', { reason: 'task-deleted' });
          }
          if (this.#data.slots.some((s) => s.linkedTaskId === input.id)) {
            this.#data.slots = this.#data.slots.map((s) => (s.linkedTaskId === input.id ? omitUndefined({ ...s, linkedTaskId: undefined }) : s));
            this.#emitSlots();
          }
          this.#emitTasks();
          return null;
        }),
      reorder: (input) =>
        this.#reply(() => {
          const flat = input.kind == null || input.kind === 'task';
          const rank = new Map(input.ids.map((id, i) => [id, i]));
          if (flat) {
            const rest = this.#data.tasks
              .filter((t) => !rank.has(t.id))
              .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
            this.#data.tasks = this.#data.tasks.map((t) => ({
              ...t,
              order: rank.get(t.id) ?? input.ids.length + rest.indexOf(t),
            }));
            this.#emitTasks();
            return this.#taskList().tasks;
          }
          this.#data.tasks = this.#data.tasks.map((t) =>
            t.kind === input.kind && rank.has(t.id) ? { ...t, order: rank.get(t.id) ?? t.order } : t,
          );
          this.#emitTasks();
          return this.#taskList().tasks.filter((t) => t.kind === input.kind);
        }),
    };

    this.notes = {
      list: (input) => this.#reply(() => this.#listNotes(input)),
      create: (input) =>
        this.#reply(() => {
          const content = input.content.trim();
          if (!content) fail('notes/content-required');
          if (input.taskId) this.#task(input.taskId);
          const now = this.#clock.now();
          const note: Note = { id: this.#id('n'), content, taskId: input.taskId ?? null, createdAt: now, updatedAt: now };
          this.#data.notes.push(note);
          this.#emit('notes:changed', { reason: 'created' });
          return note;
        }),
      update: (input) =>
        this.#reply(() => {
          const note = this.#data.notes.find((n) => n.id === input.id) ?? fail('notes/not-found', input.id);
          const content = input.content.trim();
          if (!content) fail('notes/content-required');
          const next = { ...note, content, updatedAt: this.#clock.now() };
          this.#data.notes = this.#data.notes.map((n) => (n.id === note.id ? next : n));
          this.#emit('notes:changed', { reason: 'updated' });
          return next;
        }),
      delete: (input) =>
        this.#reply(() => {
          if (!this.#data.notes.some((n) => n.id === input.id)) fail('notes/not-found', input.id);
          this.#data.notes = this.#data.notes.filter((n) => n.id !== input.id);
          this.#emit('notes:changed', { reason: 'deleted' });
          return null;
        }),
    };

    this.settings = {
      get: () => this.#reply(() => this.#data.settings),
      update: (patch) =>
        this.#reply(() => {
          const prev = this.#data.settings;
          const next: Settings = { ...prev };
          if (patch.theme === 'stone' || patch.theme === 'graphite') next.theme = patch.theme;
          if (typeof patch.dayStartHour === 'number') next.dayStartHour = clampInt(patch.dayStartHour, 0, 23);
          if (typeof patch.volume === 'number') next.volume = clampInt(patch.volume, 0, 10);
          if (typeof patch.sound === 'boolean') next.sound = patch.sound;
          if (typeof patch.pinned === 'boolean') next.pinned = patch.pinned;
          if (patch.barMode !== undefined && BAR_MODES.includes(patch.barMode)) next.barMode = patch.barMode;
          // null forgets where the bar was dragged; the host puts it back in its default place.
          for (const key of ['barX', 'barY'] as const) {
            const v = patch[key];
            if (v === null) delete next[key];
            else if (typeof v === 'number' && Number.isFinite(v)) next[key] = Math.round(v);
          }
          this.#data.settings = next;
          this.#emit('settings:changed', next);
          if (next.dayStartHour !== prev.dayStartHour) {
            this.#period = this.#periodKey();
            this.#rollTasks();
            this.#emitTasks();
          }
          return next;
        }),
    };

    this.dock = {
      resize: (geom) =>
        this.#reply(() => {
          this.lastGeometry = geom;
          this.panelOpen = geom.expanded;
          return null;
        }),
      toggle: (input) =>
        this.#reply(() => {
          const expanded = input?.expanded ?? !this.panelOpen;
          this.panelOpen = expanded;
          // The host tells every window, the bar included, as its global shortcut does.
          this.#emit('dock:toggle', { expanded });
          return { expanded };
        }),
      quit: () =>
        this.#reply(() => {
          this.quitRequested = true;
          return null;
        }),
    };
  }

  on<E extends BridgeEventName>(event: E, listener: (payload: BridgeEvents[E]) => void): () => void {
    const set = this.#listeners.get(event) ?? new Set<Listener>();
    this.#listeners.set(event, set);
    const wrapped: Listener = (payload) => listener(payload as BridgeEvents[E]);
    set.add(wrapped);
    return () => set.delete(wrapped);
  }

  /** What the host's global shortcut would send. */
  toggleDock(expanded?: boolean): void {
    this.#emit('dock:toggle', expanded === undefined ? {} : { expanded });
  }

  /** A snapshot of the stored data, for tests and the browser console. */
  snapshot(): MockData {
    return jsonClone(this.#data);
  }

  dispose(): void {
    this.#stopTicker();
    this.#listeners.clear();
  }

  // ---- internals ----

  #reply<T>(fn: () => T): Promise<T> {
    try {
      const out = fn();
      this.#save();
      return Promise.resolve(jsonClone(out));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #emit<E extends BridgeEventName>(event: E, payload: BridgeEvents[E]): void {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return;
    const data = jsonClone(payload);
    // Events reach the page after the call that caused them returns, as from Go.
    queueMicrotask(() => {
      for (const listener of [...set]) listener(jsonClone(data));
    });
  }

  #emitSlots(): void {
    this.#emit('workbench:changed', sortSlots(this.#data.slots));
  }

  #emitTasks(): void {
    this.#emit('tasks:changed', this.#taskList());
  }

  #tick(): void {
    const fired = this.#fireReminders();
    const rolled = this.#periodKey() !== this.#period;
    if (rolled) {
      this.#period = this.#periodKey();
      this.#rollTasks();
    }
    if (fired || rolled) this.#save();
    if (fired) this.#emitSlots();
    if (rolled) this.#emitTasks();
  }

  #fireReminders(): boolean {
    const { slots, fired } = fireDueReminders(this.#data.slots, this.#clock.now());
    if (fired.length === 0) return false;
    this.#data.slots = slots;
    return true;
  }

  #rollTasks(): void {
    const { dayStartHour } = this.#data.settings;
    this.#data.tasks = this.#data.tasks.map((t) => withDue(rollDaily(t, this.#period, dayStartHour), this.#period, dayStartHour));
  }

  #periodKey(): string {
    return periodKeyOf(this.#clock.now(), this.#data.settings.dayStartHour);
  }

  #due(task: Task): Task {
    return withDue(task, this.#period, this.#data.settings.dayStartHour);
  }

  #taskList(): TaskList {
    const tasks = [...this.#data.tasks].sort(
      (a, b) => a.order - b.order || a.kind.localeCompare(b.kind) || a.createdAt - b.createdAt,
    );
    return { periodKey: this.#period, tasks };
  }

  #listNotes(input: NoteListInput | undefined): Note[] {
    const query = input?.query?.trim().toLowerCase() ?? '';
    let notes = this.#data.notes;
    if (input?.taskId === null) notes = notes.filter((n) => n.taskId === null);
    else if (typeof input?.taskId === 'string') notes = notes.filter((n) => n.taskId === input.taskId);
    if (query) notes = notes.filter((n) => n.content.toLowerCase().includes(query));
    const sorted = [...notes].sort((a, b) => b.createdAt - a.createdAt);
    return input?.limit && input.limit > 0 ? sorted.slice(0, input.limit) : sorted;
  }

  #slot(id: string): WorkSlot {
    return this.#data.slots.find((s) => s.id === id) ?? fail('workbench/not-found', id);
  }

  #task(id: string): Task;
  #task(id: string, required: false): Task | undefined;
  #task(id: string, required = true): Task | undefined {
    const task = this.#data.tasks.find((t) => t.id === id);
    if (!task && required) fail('task/not-found', id);
    return task;
  }

  #replaceSlot(slot: WorkSlot): void {
    this.#data.slots = this.#data.slots.map((s) => (s.id === slot.id ? slot : s));
  }

  #replaceTask(task: Task): void {
    const next = this.#due(omitUndefined(task));
    this.#data.tasks = this.#data.tasks.map((t) => (t.id === task.id ? next : t));
  }

  #newItem(text: string, target?: number): TaskItem {
    const t = target != null && target > 0 ? Math.floor(target) : undefined;
    return omitUndefined({ id: this.#id('i'), text: text.trim(), done: false, current: t ? 0 : undefined, target: t });
  }

  #id(prefix: string): string {
    this.#data.seq += 1;
    return `${prefix}-${this.#data.seq}`;
  }

  #load(): MockData | null {
    if (!this.#storage) return null;
    try {
      const raw = this.#storage.getItem(this.#key);
      if (!raw) return null;
      const data = JSON.parse(raw) as Partial<MockData>;
      if (data.version !== 2 || !Array.isArray(data.slots) || !Array.isArray(data.tasks) || !Array.isArray(data.notes)) return null;
      // Data saved before barMode existed reads as "auto".
      const settings: Settings = { ...DEFAULT_SETTINGS, ...data.settings };
      if (!BAR_MODES.includes(settings.barMode)) settings.barMode = DEFAULT_SETTINGS.barMode;
      return {
        version: 2,
        seq: typeof data.seq === 'number' ? data.seq : 1000,
        slots: data.slots,
        tasks: data.tasks,
        notes: data.notes,
        settings,
      };
    } catch {
      return null;
    }
  }

  #save(): void {
    if (!this.#storage) return;
    try {
      this.#storage.setItem(this.#key, JSON.stringify(this.#data));
    } catch {
      // A full or blocked storage leaves the session in memory.
    }
  }
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
