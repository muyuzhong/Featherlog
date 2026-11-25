import { omitUndefined } from '../lib/json';
import { LocalMockBridge, type MockOptions } from './mock';
import {
  BAR_MODES,
  DEFAULT_SETTINGS,
  type BridgeEventName,
  type BridgeEvents,
  type DockService,
  type DockToggleResult,
  type Note,
  type NoteService,
  type Settings,
  type SettingsService,
  type Task,
  type TaskList,
  type TaskService,
  type WorkbenchService,
  type WorkSlot,
} from './types';

/** What the UI talks to: the Go services in a MyGo window, or the local mock anywhere else. */
export interface Bridge {
  readonly kind: 'mygo' | 'mock';
  readonly workbench: WorkbenchService;
  readonly tasks: TaskService;
  readonly notes: NoteService;
  readonly settings: SettingsService;
  readonly dock: DockService;
  on<E extends BridgeEventName>(event: E, listener: (payload: BridgeEvents[E]) => void): () => void;
}

/** The part of MyGo's injected runtime (window.mygo) the bridge uses. */
export interface RuntimeLike {
  call(method: string, ...args: unknown[]): Promise<unknown>;
  on(name: string, listener: (payload: unknown) => void): () => void;
}

export function isRuntimeLike(value: unknown): value is RuntimeLike {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { call?: unknown; on?: unknown };
  return typeof v.call === 'function' && typeof v.on === 'function';
}

/**
 * The host's runtime, if the page runs in one: an explicit
 * window.__FEATHERLOG_MYGO__ first (a test harness or a shim the host
 * injects), then MyGo's own window.mygo.
 */
export function findRuntime(scope: object = globalThis): RuntimeLike | null {
  const s = scope as { __FEATHERLOG_MYGO__?: unknown; mygo?: unknown };
  if (isRuntimeLike(s.__FEATHERLOG_MYGO__)) return s.__FEATHERLOG_MYGO__;
  if (isRuntimeLike(s.mygo)) return s.mygo;
  return null;
}

/** Bound Go methods are called as "Service.Method", the Go names. */
export const GO_METHODS = {
  workbench: {
    list: 'WorkbenchService.List',
    create: 'WorkbenchService.Create',
    update: 'WorkbenchService.Update',
    setState: 'WorkbenchService.SetState',
    complete: 'WorkbenchService.Complete',
    reorder: 'WorkbenchService.Reorder',
  },
  tasks: {
    list: 'TaskService.List',
    create: 'TaskService.Create',
    update: 'TaskService.Update',
    setItems: 'TaskService.SetItems',
    toggleItem: 'TaskService.ToggleItem',
    stepQuota: 'TaskService.StepQuota',
    complete: 'TaskService.Complete',
    delete: 'TaskService.Delete',
    reorder: 'TaskService.Reorder',
  },
  notes: {
    list: 'NoteService.List',
    create: 'NoteService.Create',
    update: 'NoteService.Update',
    delete: 'NoteService.Delete',
  },
  settings: { get: 'SettingsService.Get', update: 'SettingsService.Update' },
  dock: { resize: 'DockService.Resize', quit: 'DockService.Quit', toggle: 'DockService.Toggle' },
} as const;

// Go sends a nil slice as [] but a nil pointer as null; the UI reads optional
// fields as absent, so nulls on them are dropped.
function dropNulls<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) if (v !== null && v !== undefined) out[key] = v;
  return out as T;
}

export function normalizeSlot(slot: WorkSlot): WorkSlot {
  return dropNulls({ ...slot, breadcrumb: slot.breadcrumb ?? '' });
}

export function normalizeTask(task: Task): Task {
  return dropNulls({ ...task, items: (task.items ?? []).map((i) => dropNulls(i)) });
}

export function normalizeTaskList(list: TaskList): TaskList {
  return { periodKey: list.periodKey, tasks: (list.tasks ?? []).map(normalizeTask) };
}

/** A backend from before barMode reads as "auto"; an unknown mode too. */
export function normalizeSettings(settings: Settings): Settings {
  const s = { ...DEFAULT_SETTINGS, ...omitUndefined(settings ?? {}) };
  if (!BAR_MODES.includes(s.barMode)) s.barMode = DEFAULT_SETTINGS.barMode;
  return s;
}

export function normalizeNote(note: Note): Note {
  return { ...note, taskId: note.taskId ?? null };
}

const slots = (list: WorkSlot[] | null): WorkSlot[] => (list ?? []).map(normalizeSlot);

export class MyGoBridge implements Bridge {
  readonly kind = 'mygo' as const;
  readonly workbench: WorkbenchService;
  readonly tasks: TaskService;
  readonly notes: NoteService;
  readonly settings: SettingsService;
  readonly dock: DockService;
  readonly #rt: RuntimeLike;

  constructor(rt: RuntimeLike) {
    this.#rt = rt;
    const call = <T>(method: string, input?: object): Promise<T> =>
      (input === undefined ? rt.call(method) : rt.call(method, omitUndefined(input))) as Promise<T>;
    const W = GO_METHODS.workbench;
    const T = GO_METHODS.tasks;
    const N = GO_METHODS.notes;
    this.workbench = {
      list: () => call<WorkSlot[] | null>(W.list).then(slots),
      create: (input) => call<WorkSlot>(W.create, input).then(normalizeSlot),
      update: (input) => call<WorkSlot>(W.update, input).then(normalizeSlot),
      setState: (input) => call<WorkSlot[] | null>(W.setState, input).then(slots),
      complete: (input) => call<WorkSlot[] | null>(W.complete, input).then(slots),
      reorder: (input) => call<WorkSlot[] | null>(W.reorder, input).then(slots),
    };
    this.tasks = {
      list: () => call<TaskList>(T.list).then(normalizeTaskList),
      create: (input) => call<Task>(T.create, input).then(normalizeTask),
      update: (input) => call<Task>(T.update, input).then(normalizeTask),
      setItems: (input) => call<Task>(T.setItems, input).then(normalizeTask),
      toggleItem: (input) => call<Task>(T.toggleItem, input).then(normalizeTask),
      stepQuota: (input) => call<Task>(T.stepQuota, input).then(normalizeTask),
      complete: (input) => call<Task>(T.complete, input).then(normalizeTask),
      delete: (input) => call<null>(T.delete, input),
      reorder: (input) => call<Task[] | null>(T.reorder, input).then((list) => (list ?? []).map(normalizeTask)),
    };
    this.notes = {
      list: (input) => call<Note[] | null>(N.list, input ?? {}).then((list) => (list ?? []).map(normalizeNote)),
      create: (input) => call<Note>(N.create, input).then(normalizeNote),
      update: (input) => call<Note>(N.update, input).then(normalizeNote),
      delete: (input) => call<null>(N.delete, input),
    };
    this.settings = {
      get: () => call<Settings>(GO_METHODS.settings.get).then(normalizeSettings),
      update: (patch) => call<Settings>(GO_METHODS.settings.update, patch).then(normalizeSettings),
    };
    this.dock = {
      resize: (geom) => call<null>(GO_METHODS.dock.resize, geom),
      quit: () => call<null>(GO_METHODS.dock.quit),
      toggle: (input) =>
        call<DockToggleResult | null>(GO_METHODS.dock.toggle, input ?? {}).then((r) => ({ expanded: Boolean(r?.expanded) })),
    };
  }

  on<E extends BridgeEventName>(event: E, listener: (payload: BridgeEvents[E]) => void): () => void {
    return this.#rt.on(event, (payload) => listener(normalizeEvent(event, payload)));
  }
}

function normalizeEvent<E extends BridgeEventName>(event: E, payload: unknown): BridgeEvents[E] {
  if (event === 'workbench:changed') return slots(payload as WorkSlot[] | null) as BridgeEvents[E];
  if (event === 'tasks:changed') return normalizeTaskList(payload as TaskList) as BridgeEvents[E];
  if (event === 'dock:toggle') return (payload ?? {}) as BridgeEvents[E];
  if (event === 'settings:changed') return normalizeSettings(payload as Settings) as BridgeEvents[E];
  return payload as BridgeEvents[E];
}

export interface CreateBridgeOptions {
  /** where to look for the runtime; globalThis by default */
  scope?: object;
  /** 'mock' forces the local mock even inside a host */
  force?: 'mock';
  mock?: MockOptions;
}

export function createBridge(options: CreateBridgeOptions = {}): Bridge {
  const runtime = options.force === 'mock' ? null : findRuntime(options.scope);
  return runtime ? new MyGoBridge(runtime) : new LocalMockBridge(options.mock);
}
