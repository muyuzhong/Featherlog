import type { IsoDateTime, LocalDate } from './envelope';

/**
 * main  = 主线: long-term goal or study plan, measured by numeric progress or by its children.
 * side  = 支线: one-off to-do. May belong to a main quest.
 * daily = 日常: recurring habit; completion resets every period.
 */
export type QuestKind = 'main' | 'side' | 'daily';

export type QuestStatus = 'active' | 'completed' | 'archived';

export type QuestPriority = 'none' | 'low' | 'medium' | 'high';

export interface QuestProgress {
  current: number;
  target: number;
  /** Display unit, e.g. "张", "页", "章". */
  unit?: string;
}

export type Recurrence =
  | { freq: 'daily' }
  /** 0 = Sunday … 6 = Saturday. */
  | { freq: 'weekly'; weekdays: number[] };

/** Daily quests only: state of the current period. */
export interface QuestCycle {
  /** Local date of the current period, shifted by the `dayStartHour` setting. */
  periodKey: LocalDate;
  /** Count toward `progress.target` for this period (for "背 10 张卡"-style dailies). */
  current: number;
  done: boolean;
}

/** Computed by the quest plugin on every read. Clients never write these. */
export interface QuestDerived {
  /** 0..1. main: progress.current/target, else children done/total. side: 0 or 1. daily: this period. */
  ratio: number;
  childCount: number;
  childDone: number;
  /** daily: consecutive due periods completed, counting the current one only if done. Otherwise 0. */
  streak: number;
  /** Would appear in "quest/today". */
  dueToday: boolean;
  /** Active and `deadline` is before today. */
  overdue: boolean;
}

export interface Quest {
  id: string;
  kind: QuestKind;
  title: string;
  notes?: string;
  /** Only a side quest may have a parent, and the parent must be a main quest. */
  parentId?: string;
  /** daily quests stay "active" and track completion in `cycle`. */
  status: QuestStatus;
  priority: QuestPriority;
  /** main: optional numeric progress. daily: optional per-period target. side: unused. */
  progress?: QuestProgress;
  deadline?: LocalDate;
  /** The day the user plans to do it; puts a side quest into "today". */
  scheduledFor?: LocalDate;
  estimateMinutes?: number;
  /** daily only. */
  recurrence?: Recurrence;
  /** daily only. */
  cycle?: QuestCycle;
  /** Manual sort key among siblings, ascending. */
  order: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** main/side only. */
  completedAt?: IsoDateTime;
  derived: QuestDerived;
}

export interface QuestInput {
  kind: QuestKind;
  title: string;
  notes?: string;
  parentId?: string;
  priority?: QuestPriority;
  progress?: { target: number; current?: number; unit?: string };
  deadline?: LocalDate;
  scheduledFor?: LocalDate;
  estimateMinutes?: number;
  /** Required for daily, forbidden otherwise. */
  recurrence?: Recurrence;
}

/** Omitted = unchanged, `null` = clear the field. `kind` cannot change. */
export type QuestPatch = {
  [K in Exclude<keyof QuestInput, 'kind'>]?: QuestInput[K] | null;
};

export interface QuestFilter {
  kind?: QuestKind;
  status?: QuestStatus;
  /** `null` = top-level quests only. */
  parentId?: string | null;
}

/** Error codes thrown by quest handlers. */
export type QuestErrorCode = 'quest/not-found' | 'quest/invalid-input' | 'quest/has-children';

export interface QuestEvents {
  'quest/created': { quest: Quest };
  /** `changed` lists the top-level Quest fields that changed. */
  'quest/updated': { quest: Quest; changed: string[] };
  /** For a daily quest, `periodKey` is the period that was completed. */
  'quest/completed': { quest: Quest; periodKey?: LocalDate };
  'quest/uncompleted': { quest: Quest; periodKey?: LocalDate };
  'quest/progressed': { quest: Quest; previous: number; current: number };
  'quest/deleted': { id: string };
  /** The day boundary passed while running; daily cycles have been reset. */
  'quest/period-rolled': { previous: LocalDate; current: LocalDate };
}

export interface QuestRequests {
  'quest/list': { req: { filter?: QuestFilter }; res: { quests: Quest[] } };
  'quest/get': { req: { id: string }; res: { quest: Quest } };
  /**
   * The "今日任务" list, already sorted (see docs/design.md §8.4). Used by
   * both the panel home and the collapsed preview so they always agree.
   */
  'quest/today': { req: Record<string, never>; res: { date: LocalDate; quests: Quest[] } };
  'quest/create': { req: { input: QuestInput }; res: { quest: Quest } };
  'quest/update': { req: { id: string; patch: QuestPatch }; res: { quest: Quest } };
  /** side/main: mark completed. daily: complete the current period. */
  'quest/complete': { req: { id: string }; res: { quest: Quest } };
  /** Undo of "quest/complete". */
  'quest/uncomplete': { req: { id: string }; res: { quest: Quest } };
  /** Exactly one of `delta` / `set`. Applies to `progress` (main) or `cycle.current` (daily). */
  'quest/progress': {
    req: { id: string; delta?: number; set?: number };
    res: { quest: Quest };
  };
  'quest/archive': { req: { id: string }; res: { quest: Quest } };
  /** Fails with "quest/has-children" unless `cascade` is true. */
  'quest/delete': { req: { id: string; cascade?: boolean }; res: null };
  /** Sets `order` of the given siblings to their index in `ids`. */
  'quest/reorder': { req: { ids: string[] }; res: null };
}
