// The v2 contract shared by the Go services (bound with mygo.Bind) and this
// frontend. Payloads are plain JSON: times are Unix milliseconds, dates are
// YYYY-MM-DD strings, and optional fields are omitted rather than undefined.

export type WorkSlotState = 'focus' | 'running' | 'ready';

export interface WorkSlot {
  id: string;
  title: string;
  state: WorkSlotState;
  /** 一句话断点备忘 / 下一步锚点 */
  breadcrumb: string;
  /** 可选项目/上下文短标签，如 "Featherlog"、"PR #42" */
  tag?: string;
  /** 可选关联的任务 ID */
  linkedTaskId?: string;
  /** 最近一次进入当前状态的时间（Unix ms），用于计算 running 挂起时长 */
  stateChangedAt: number;
  /** 可选：到点自动从 running 转为 ready 的提醒时间（Unix ms） */
  remindAt?: number;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export type TaskKind = 'main' | 'side' | 'daily';
export type TaskStatus = 'active' | 'completed' | 'archived';

export interface TaskItem {
  id: string;
  text: string;
  done: boolean;
  current?: number;
  target?: number;
}

export interface TaskQuota {
  current: number;
  target: number;
}

export interface TaskRecurrence {
  freq: 'daily' | 'weekly';
  /** 0 (Sun) - 6 (Sat)，仅 weekly 使用 */
  weekdays?: number[];
}

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  /** 自由勾选的子项（main / side 可选，无顺序锁） */
  items: TaskItem[];
  /** 可选目标配额/次数，如 { current: 2, target: 5 } */
  quota?: TaskQuota;
  /** 仅 daily 必填 */
  recurrence?: TaskRecurrence;
  /** daily 当前周期键 YYYY-MM-DD */
  periodKey?: string;
  /** daily 连续完成周期数（仅展示，无断签惩罚） */
  streak?: number;
  deadline?: string;
  scheduledFor?: string;
  dueToday: boolean;
  overdue: boolean;
  order: number;
  createdAt: number;
  completedAt?: number;
}

export interface Note {
  id: string;
  content: string;
  /** 有值表示挂在任务下的手记，null/省略表示独立随笔 */
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ThemeMode = 'stone' | 'graphite';

/** The UI language: 简体中文 or English. */
export type Language = 'zh' | 'en';

export const LANGUAGES: readonly Language[] = ['zh', 'en'];

export interface Settings {
  theme: ThemeMode;
  /** 0-23, default 4 */
  dayStartHour: number;
  /** default true */
  sound: boolean;
  /** 0-10, default 5 */
  volume: number;
  /** default false */
  pinned: boolean;
  /** default "zh"; a missing or unknown value reads as "zh", and "zh-CN" as "zh" */
  language: Language;
  /** Where the user dragged the standalone bar (screen px); null or absent: the host's default place. */
  barX?: number | null;
  barY?: number | null;
}

export interface DockGeometry {
  width: number;
  height: number;
  expanded: boolean;
  pinned?: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'stone',
  dayStartHour: 4,
  sound: true,
  volume: 5,
  pinned: false,
  language: 'zh',
};

// ---- Service inputs (one JSON object per call) ----

export interface WorkbenchCreateInput {
  title: string;
  tag?: string;
  breadcrumb?: string;
  state?: WorkSlotState;
  linkedTaskId?: string;
}

export interface WorkbenchUpdateInput {
  id: string;
  title?: string;
  tag?: string;
  breadcrumb?: string;
  linkedTaskId?: string | null;
}

export interface WorkbenchSetStateInput {
  id: string;
  state: WorkSlotState;
  remindInMinutes?: number | null;
}

export interface WorkbenchCompleteInput {
  id: string;
  completeLinkedTask?: boolean;
}

export interface WorkbenchReorderInput {
  ids: string[];
}

export interface TaskList {
  periodKey: string;
  tasks: Task[];
}

export interface TaskItemDraft {
  text: string;
  target?: number;
}

export interface TaskCreateInput {
  /** Omitted or 'task' defaults to a plain todo (or daily when recurrence is provided). */
  kind?: TaskKind | 'task';
  title: string;
  items?: TaskItemDraft[];
  quotaTarget?: number;
  recurrence?: TaskRecurrence;
  deadline?: string;
  scheduledFor?: string;
}

export interface TaskUpdateInput {
  id: string;
  title?: string;
  quotaTarget?: number | null;
  /** Set to enable/update daily or weekly reset on any task; null clears recurrence and returns it to a plain todo. */
  recurrence?: TaskRecurrence | null;
  deadline?: string | null;
  scheduledFor?: string | null;
  status?: TaskStatus;
}

export interface TaskItemInput {
  id?: string;
  text: string;
  done?: boolean;
  current?: number;
  target?: number;
}

export interface TaskSetItemsInput {
  id: string;
  items: TaskItemInput[];
}

export interface TaskToggleItemInput {
  taskId: string;
  itemId: string;
  done?: boolean;
}

export interface TaskStepQuotaInput {
  id: string;
  itemId?: string;
  /** +1 or -1 */
  delta: number;
}

export interface TaskCompleteInput {
  id: string;
  completed: boolean;
}

export interface TaskDeleteInput {
  id: string;
}

export interface TaskReorderInput {
  /** Omitted or 'task' reorders across the flat task list directly. */
  kind?: TaskKind | 'task';
  ids: string[];
}

export interface NoteListInput {
  /** omitted: every note; null: standalone notes only; an id: that task's notes */
  taskId?: string | null;
  query?: string;
  limit?: number;
}

export interface NoteCreateInput {
  content: string;
  taskId?: string | null;
}

export interface NoteUpdateInput {
  id: string;
  content: string;
}

export interface NoteDeleteInput {
  id: string;
}

// ---- The five bound Go services, as the generated client names them ----

export interface WorkbenchService {
  list(): Promise<WorkSlot[]>;
  create(input: WorkbenchCreateInput): Promise<WorkSlot>;
  update(input: WorkbenchUpdateInput): Promise<WorkSlot>;
  /** Focusing a slot sends the previous focus back to running; returns the whole list. */
  setState(input: WorkbenchSetStateInput): Promise<WorkSlot[]>;
  complete(input: WorkbenchCompleteInput): Promise<WorkSlot[]>;
  reorder(input: WorkbenchReorderInput): Promise<WorkSlot[]>;
}

export interface TaskService {
  list(): Promise<TaskList>;
  create(input: TaskCreateInput): Promise<Task>;
  update(input: TaskUpdateInput): Promise<Task>;
  setItems(input: TaskSetItemsInput): Promise<Task>;
  toggleItem(input: TaskToggleItemInput): Promise<Task>;
  stepQuota(input: TaskStepQuotaInput): Promise<Task>;
  complete(input: TaskCompleteInput): Promise<Task>;
  delete(input: TaskDeleteInput): Promise<null>;
  reorder(input: TaskReorderInput): Promise<Task[]>;
}

export interface NoteService {
  list(input?: NoteListInput): Promise<Note[]>;
  create(input: NoteCreateInput): Promise<Note>;
  update(input: NoteUpdateInput): Promise<Note>;
  delete(input: NoteDeleteInput): Promise<null>;
}

export interface SettingsService {
  get(): Promise<Settings>;
  update(patch: Partial<Settings>): Promise<Settings>;
}

export interface DockToggleInput {
  /** true opens, false hides; absent flips */
  expanded?: boolean;
}

export interface DockToggleResult {
  expanded: boolean;
}

export interface DockService {
  resize(geom: DockGeometry): Promise<null>;
  quit(): Promise<null>;
  /** Shows or hides the host's 880×520 workbench window (the standalone bar lives in its own window). */
  toggle(input?: DockToggleInput): Promise<DockToggleResult>;
}

// ---- Events the backend pushes ----

export interface BridgeEvents {
  'workbench:changed': WorkSlot[];
  'tasks:changed': TaskList;
  'notes:changed': { reason: string };
  'settings:changed': Settings;
  'dock:toggle': { expanded?: boolean };
}

export type BridgeEventName = keyof BridgeEvents;

export const BRIDGE_EVENTS: readonly BridgeEventName[] = [
  'workbench:changed',
  'tasks:changed',
  'notes:changed',
  'settings:changed',
  'dock:toggle',
];
