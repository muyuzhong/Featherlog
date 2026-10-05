import type { IsoDateTime } from './envelope';
import type { QuestAttribute } from './quest';

/*
 * The character page (design §16): growth read from the quest journal. Quests
 * carry attributes; completing them earns 历练 toward each attribute's 境界, and
 * milestones earn titles. Nothing here is spent: there are no coins, no shop.
 */

/** One attribute's standing. */
export interface AttributeStanding {
  attribute: QuestAttribute;
  /** Total 历练 earned toward it. */
  points: number;
  /** 0 = 未涉 … 6 = 化境 (§16.3). */
  rank: number;
  /** The rank's name, e.g. "小成". */
  rankName: string;
  /** 历练 at which the current rank began. */
  rankFrom: number;
  /** 历练 needed for the next rank; absent at the top rank. */
  nextAt?: number;
}

export interface CharacterTitle {
  id: string;
  name: string;
  /** How it is earned, in words, e.g. "完成第一条主线". Inscribed titles say which quest. */
  hint: string;
  /** Absent while not yet earned. Titles are never lost once earned. */
  earnedAt?: IsoDateTime;
  /** Inscribed by 翎 for this completed main quest; absent for the fixed titles. */
  questId?: string;
}

export interface CharacterSheet {
  /** Always all four, in the order 学识, 体魄, 心性, 技艺. */
  attributes: AttributeStanding[];
  /** 历练 from quests with no attribute; it moves to an attribute when one is chosen. */
  unassigned: number;
  /** Every fixed title (earned or not) and every inscribed title. */
  titles: CharacterTitle[];
  /** The title the player wears; null when none. */
  worn: string | null;
}

export type ChronicleEntry = { id: string; at: IsoDateTime } & (
  | { kind: 'quest-completed'; questId: string; questKind: 'main' | 'side'; label: string }
  | { kind: 'chapter-completed'; questId: string; label: string; chapterTitle: string }
  | { kind: 'rank'; attribute: QuestAttribute; rank: number; rankName: string }
  | { kind: 'title'; titleId: string; titleName: string }
);

/** A moment worth a toast: a new rank or a new title. */
export type CharacterMilestone =
  | { kind: 'rank'; attribute: QuestAttribute; rank: number; rankName: string }
  | { kind: 'title'; title: CharacterTitle };

/** Error codes thrown by character handlers. */
export type CharacterErrorCode = 'character/not-found' | 'character/invalid-input';

export interface CharacterEvents {
  /** Any change to the sheet: 历练, a title, the worn title. */
  'character/changed': { sheet: CharacterSheet };
  'character/milestone': { milestone: CharacterMilestone };
}

export interface CharacterRequests {
  'character/sheet': { req: Record<string, never>; res: CharacterSheet };
  /** Newest first; `before`/`limit` page backwards (default 50). */
  'character/chronicle': {
    req: { before?: IsoDateTime; limit?: number };
    res: { entries: ChronicleEntry[]; more: boolean };
  };
  /** Wear an earned title, or none with null. An unearned or unknown title is "character/not-found". */
  'character/wear': { req: { titleId: string | null }; res: CharacterSheet };
}
