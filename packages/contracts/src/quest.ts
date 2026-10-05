import type { IsoDateTime, LocalDate } from './envelope';

/**
 * main  = 主线: a quest line split into chapters; each chapter is a sequence of objectives.
 * side  = 支线: a single-chapter quest; may have no objectives at all (one deed).
 * daily = 每日委托: recurring; completion resets every period.
 */
export type QuestKind = 'main' | 'side' | 'daily';

export type QuestStatus = 'active' | 'completed' | 'archived';

export type QuestPriority = 'none' | 'low' | 'medium' | 'high';

/**
 * What a quest trains, for the character page (design §16): 学识, 体魄, 心性, 技艺.
 * The quest plugin only stores and validates them; growth is the character plugin's.
 */
export type QuestAttribute = 'learning' | 'body' | 'mind' | 'craft';

export interface Count {
  current: number;
  target: number;
  /** Display unit, e.g. "张", "页". */
  unit?: string;
}

export interface Objective {
  id: string;
  text: string;
  detail?: string;
  /** A counted objective ("背 30 张卡片", 12/30) completes when `current` reaches `target`. */
  count?: Count;
  doneAt?: IsoDateTime;
}

export interface Chapter {
  id: string;
  /** Empty for a side quest's only chapter. */
  title: string;
  /** Main quests only: this chapter's own deadline (e.g. one book of a reading plan). */
  deadline?: LocalDate;
  objectives: Objective[];
  doneAt?: IsoDateTime;
}

export type Recurrence =
  | { freq: 'daily' }
  /** 0 = Sunday … 6 = Saturday. */
  | { freq: 'weekly'; weekdays: number[] };

/** Daily quests only: state of the current period. */
export interface QuestCycle {
  /** Local date of the current period, shifted by the `dayStartHour` setting. */
  periodKey: LocalDate;
  /** Count toward `quota.target` in this period. */
  current: number;
  done: boolean;
}

/** Computed by the quest plugin on every read. Clients never write these. */
export interface QuestDerived {
  /** Index of the first unfinished chapter; `chapters.length` when all are done. */
  chapterIndex: number;
  /** Index of the current objective inside that chapter; -1 when there is none. */
  objectiveIndex: number;
  /** 0..1 over every objective of the quest. daily: this period. */
  ratio: number;
  /** 0..1 inside the current chapter. */
  chapterRatio: number;
  /** daily: consecutive due periods completed. Otherwise 0. */
  streak: number;
  /** daily due this period, or a side/main quest (or a main quest's current chapter) scheduled/due today or earlier. */
  dueToday: boolean;
  /** Active and `deadline`, or the current chapter's deadline, is before today. */
  overdue: boolean;
  /** The current chapter's deadline, if it has one. */
  chapterDeadline?: LocalDate;
}

export interface Quest {
  id: string;
  kind: QuestKind;
  /** The real-world goal, e.g. "背完 Redis 八股". Always present. */
  title: string;
  /** Optional in-world name, e.g. "内存之王". UIs fall back to `title`. */
  name?: string;
  /** Optional briefing or story. */
  story?: string;
  status: QuestStatus;
  priority: QuestPriority;
  /** At most one quest is tracked at a time. */
  tracked: boolean;
  /** Show objectives the player has not reached yet. Default false: they stay hidden. */
  revealed: boolean;
  /** main: one or more chapters. side: exactly one. daily: none. */
  chapters: Chapter[];
  deadline?: LocalDate;
  /** The day the player plans to do it. */
  scheduledFor?: LocalDate;
  /** daily only. */
  recurrence?: Recurrence;
  /** daily only: per-period target, e.g. 10 for "背 10 张卡片". */
  quota?: { target: number; unit?: string };
  /** daily only. */
  cycle?: QuestCycle;
  /** One or two, no repeats; absent when none was chosen. */
  attributes?: QuestAttribute[];
  /** Manual sort key within its kind, ascending. */
  order: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** main/side only. */
  completedAt?: IsoDateTime;
  derived: QuestDerived;
}

export interface ObjectiveDraft {
  /** Present when editing an existing objective; keeps its progress. */
  id?: string;
  text: string;
  detail?: string;
  count?: { target: number; unit?: string };
}

export interface ChapterDraft {
  id?: string;
  title: string;
  /** Main quests only. */
  deadline?: LocalDate;
  objectives: ObjectiveDraft[];
}

export interface QuestInput {
  kind: QuestKind;
  title: string;
  name?: string;
  story?: string;
  priority?: QuestPriority;
  /** main: required, at least one. side: at most one; omitted = one untitled chapter. daily: forbidden. */
  chapters?: ChapterDraft[];
  deadline?: LocalDate;
  scheduledFor?: LocalDate;
  /** Required for daily, forbidden otherwise. */
  recurrence?: Recurrence;
  /** daily only. */
  quota?: { target: number; unit?: string };
  /** One or two, no repeats. An empty array means none. */
  attributes?: QuestAttribute[];
}

/** Omitted = unchanged, `null` = clear. Structure is edited with "quest/set-chapters". */
export type QuestPatch = {
  [K in 'title' | 'name' | 'story' | 'priority' | 'deadline' | 'scheduledFor' | 'recurrence' | 'quota' | 'attributes']?:
    | QuestInput[K]
    | null;
} & { revealed?: boolean };

export interface QuestFilter {
  kind?: QuestKind;
  status?: QuestStatus;
}

/** Error codes thrown by quest handlers. */
export type QuestErrorCode =
  | 'quest/not-found'
  | 'quest/invalid-input'
  /** The objective is not the current one; objectives unlock in order. */
  | 'quest/objective-locked';

export interface QuestEvents {
  'quest/created': { quest: Quest };
  /** `changed` lists the top-level Quest fields that changed. */
  'quest/updated': { quest: Quest; changed: string[] };
  'quest/objective-completed': { quest: Quest; chapterId: string; objectiveId: string };
  'quest/objective-reopened': { quest: Quest; chapterId: string; objectiveId: string };
  'quest/chapter-completed': { quest: Quest; chapterId: string };
  /** For a daily quest, `periodKey` is the period that was completed. */
  'quest/completed': { quest: Quest; periodKey?: LocalDate };
  'quest/uncompleted': { quest: Quest; periodKey?: LocalDate };
  /** A counted objective or a daily quota moved. `objectiveId` is absent for a daily quota. */
  'quest/counted': { quest: Quest; objectiveId?: string; previous: number; current: number };
  'quest/tracked': { questId: string | null; previous: string | null };
  'quest/deleted': { id: string };
  /** The day boundary passed while running; daily cycles have been reset. */
  'quest/period-rolled': { previous: LocalDate; current: LocalDate };
}

export interface QuestRequests {
  /** The quest plugin's logical period, including its configured day boundary. */
  'quest/period': { req: Record<string, never>; res: { periodKey: LocalDate; dayStartHour: number } };
  'quest/list': { req: { filter?: QuestFilter }; res: { quests: Quest[] } };
  'quest/get': { req: { id: string }; res: { quest: Quest } };
  'quest/create': { req: { input: QuestInput }; res: { quest: Quest } };
  'quest/update': { req: { id: string; patch: QuestPatch }; res: { quest: Quest } };
  /** Replace the chapter/objective structure. Drafts with an `id` keep their progress. */
  'quest/set-chapters': { req: { id: string; chapters: ChapterDraft[] }; res: { quest: Quest } };
  /** Only the current objective can be completed ("quest/objective-locked" otherwise). */
  'quest/complete-objective': { req: { id: string; objectiveId: string }; res: { quest: Quest } };
  /** Reopens the objective and every objective after it. */
  'quest/reopen-objective': { req: { id: string; objectiveId: string }; res: { quest: Quest } };
  /**
   * Counts toward the current objective's `count` (with `objectiveId`) or a daily quota
   * (without). Exactly one of `delta` / `set`. Reaching the target completes it.
   */
  'quest/count': {
    req: { id: string; objectiveId?: string; delta?: number; set?: number };
    res: { quest: Quest };
  };
  /** daily: complete this period. side/main: complete every remaining objective, then the quest. */
  'quest/complete': { req: { id: string }; res: { quest: Quest } };
  /** Undo "quest/complete". side/main: back to active with the last objective reopened. */
  'quest/uncomplete': { req: { id: string }; res: { quest: Quest } };
  /** Track one quest (untracking the previous one), or none with `null`. */
  'quest/track': { req: { id: string | null }; res: { quest: Quest | null } };
  'quest/archive': { req: { id: string }; res: { quest: Quest } };
  'quest/delete': { req: { id: string }; res: null };
  /** Sets `order` of the given quests to their index in `ids`. */
  'quest/reorder': { req: { ids: string[] }; res: null };
}
