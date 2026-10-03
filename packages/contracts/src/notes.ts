import type { IsoDateTime } from './envelope';

/*
 * Notes (design §15): a 手记 belongs to a quest (`questId`), a 随笔 to none.
 * Plain text, kept by the notes plugin; the quest UI reads and writes a quest's
 * 手记 over the bus.
 */

export interface Note {
  id: string;
  /** Plain text; line breaks are kept, nothing is parsed. */
  text: string;
  /** The quest this 手记 belongs to; absent for a 随笔. */
  questId?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface NoteInput {
  text: string;
  /** Write it as a 手记 of this quest. */
  questId?: string;
}

/** Error codes thrown by notes handlers. */
export type NotesErrorCode = 'notes/not-found' | 'notes/invalid-input';

export interface NotesEvents {
  'notes/created': { note: Note };
  /** Edited, or turned into a 随笔 because its quest was deleted. */
  'notes/updated': { note: Note };
  'notes/deleted': { id: string; questId?: string };
}

export interface NotesRequests {
  /**
   * Newest first. `questId`: a quest's 手记; `null`: only 随笔; omitted: everything.
   * `before`/`limit` page backwards (default 50); `query` is a case-insensitive substring.
   */
  'notes/list': {
    req: { questId?: string | null; query?: string; before?: IsoDateTime; limit?: number };
    res: { notes: Note[]; more: boolean };
  };
  'notes/get': { req: { id: string }; res: { note: Note } };
  'notes/create': { req: { input: NoteInput }; res: { note: Note } };
  'notes/update': { req: { id: string; text: string }; res: { note: Note } };
  'notes/delete': { req: { id: string }; res: null };
  /** How many 手记 each quest has; quests without any are 0. */
  'notes/counts': { req: { questIds: string[] }; res: { counts: Record<string, number> } };
}
