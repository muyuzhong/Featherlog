import type { IsoDateTime, LocalDate } from './envelope';
import type { ObjectiveDraft, QuestInput } from './quest';

/*
 * 翎, the scribe (design §14): an AI NPC plugin that answers the player's
 * strokes and proposes, but never writes quests itself. The model and its
 * endpoint are whatever the user configured; nothing here names a provider.
 */

/** What a line is about. */
export type ScribeTopic =
  | 'objective'
  | 'chapter'
  | 'quest'
  | 'streak'
  | 'reopen'
  | 'board'
  | 'greeting';

/** One thing 翎 said: a margin note in the scribe's own ink. */
export interface ScribeLine {
  id: string;
  text: string;
  topic: ScribeTopic;
  questId?: string;
  at: IsoDateTime;
  /** Written by the model, or one of 翎's built-in lines (unconfigured, offline, after a failure). */
  origin: 'model' | 'builtin';
}

export interface ScribeUsage {
  /** "2026-10". */
  month: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Calls whose provider reported no token usage. */
  unreported: number;
}

export interface ScribeState {
  /** The `enabled` setting. */
  enabled: boolean;
  /** The user has read and accepted what is sent where (§14.5). No network call happens before this. */
  consented: boolean;
  /** Protocol, base URL and model are set (and a key, unless the endpoint is local). */
  configured: boolean;
  /** The configured endpoint's address, to show in the consent notice. */
  endpoint?: string;
  /** Calls are suspended, e.g. after the endpoint rejected the key, until the configuration changes. */
  paused?: { reason: 'auth'; message: string };
  usage: ScribeUsage;
}

/** One of today's suggested first moves. */
export interface ScribeBoardItem {
  questId: string;
  /** The objective to do, for main and side quests. */
  objectiveId?: string;
  /** Why this one, in 翎's words. */
  reason: string;
}

export interface ScribeBoard {
  periodKey: LocalDate;
  /** At most three. */
  items: ScribeBoardItem[];
  origin: 'model' | 'builtin';
}

export interface ScribeRecap {
  periodKey: LocalDate;
  text: string;
  writtenAt: IsoDateTime;
}

export interface ScribeEpilogue {
  questId: string;
  text: string;
  writtenAt: IsoDateTime;
}

/** Error codes thrown by scribe handlers. */
export type ScribeErrorCode =
  /** Protocol, base URL, model or key missing. */
  | 'scribe/not-configured'
  /** The user has not accepted the notice of §14.5 yet. */
  | 'scribe/no-consent'
  /** The endpoint rejected the key; calls are paused. */
  | 'scribe/auth-failed'
  /** Network failure, timeout, rate limit or server error at the endpoint. */
  | 'scribe/unavailable'
  /** The model's reply could not be used (not JSON, or not a valid quest after one retry). */
  | 'scribe/unusable-reply'
  | 'scribe/invalid-input';

export interface ScribeEvents {
  /** A reaction or greeting; shown on the note and in the journal's margin. */
  'scribe/said': { line: ScribeLine };
  'scribe/state-changed': { state: ScribeState };
  'scribe/recap-written': { recap: ScribeRecap };
  'scribe/epilogue-written': { epilogue: ScribeEpilogue };
}

export interface ScribeRequests {
  'scribe/state': { req: Record<string, never>; res: ScribeState };
  /** Record the user's answer to the notice of §14.5. */
  'scribe/consent': { req: { granted: boolean }; res: ScribeState };
  /** A minimal round trip to the configured endpoint ("试一试"). */
  'scribe/test': {
    req: Record<string, never>;
    res: { ok: true; model: string; ms: number } | { ok: false; code: ScribeErrorCode; message: string };
  };
  /** A sentence → a quest draft for the editor. Nothing is written to the journal. */
  'scribe/draft-quest': { req: { text: string }; res: { input: QuestInput; note?: string } };
  /** Smaller steps for a stuck objective, for the editor to show. Nothing is written. */
  'scribe/split-objective': {
    req: { questId: string; objectiveId: string };
    res: { objectives: ObjectiveDraft[]; note?: string };
  };
  /** Today's suggested first moves; computed once per period, then cached. */
  'scribe/board': { req: Record<string, never>; res: ScribeBoard };
  /** A day's recap; writes it if `write` and it doesn't exist yet. */
  'scribe/recap': { req: { periodKey?: LocalDate; write?: boolean }; res: { recap: ScribeRecap | null } };
  /** Recent recaps, newest first. */
  'scribe/recaps': { req: { limit?: number }; res: { recaps: ScribeRecap[] } };
  'scribe/epilogue': { req: { questId: string }; res: { epilogue: ScribeEpilogue | null } };
  /** Recent lines, newest first, optionally about one quest. */
  'scribe/lines': { req: { questId?: string; limit?: number }; res: { lines: ScribeLine[] } };
}
