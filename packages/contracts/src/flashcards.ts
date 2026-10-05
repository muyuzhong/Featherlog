import type { IsoDateTime } from './envelope';

/*
 * 八股 (design §17): an optional example plugin. Question-and-answer cards,
 * reviewed one at a time from the scroll and brought back by spaced repetition.
 */

/** 忘了 / 模糊 / 记得. */
export type FlashcardGrade = 'again' | 'hard' | 'good';

export interface FlashcardReview {
  /** 0 = learning (back in minutes), 1–7 = days apart growing (§17.4). */
  box: number;
  /** When it is next due; absent for a new card that was never reviewed. */
  due?: IsoDateTime;
  /** Times reviewed, and times forgotten after it had been learned. */
  reviews: number;
  lapses: number;
  lastGrade?: FlashcardGrade;
  lastReviewedAt?: IsoDateTime;
}

export interface Flashcard {
  id: string;
  /** The deck it belongs to, e.g. "Redis"; "" when none. */
  deck: string;
  /** Plain text; line breaks are kept. */
  question: string;
  answer: string;
  review: FlashcardReview;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface FlashcardInput {
  deck?: string;
  question: string;
  answer: string;
}

export interface FlashcardDeck {
  name: string;
  total: number;
  /** Due by the end of today. */
  due: number;
  /** Never reviewed. */
  fresh: number;
}

/** Today's review, as the card on the scroll counts it. */
export interface FlashcardToday {
  /** Cards graded today. */
  reviewed: number;
  /** Still due today, plus new cards today's limit still allows. */
  remaining: number;
}

/** Error codes thrown by flashcards handlers. */
export type FlashcardsErrorCode = 'flashcards/not-found' | 'flashcards/invalid-input';

export interface FlashcardsEvents {
  'flashcards/changed': { card: Flashcard };
  'flashcards/deleted': { id: string };
  /** After an import; the cards it created are not sent one by one. */
  'flashcards/imported': { created: number };
  'flashcards/reviewed': { card: Flashcard; grade: FlashcardGrade; today: FlashcardToday };
}

export interface FlashcardsRequests {
  /** Matching cards, oldest first, and every deck with its counts. */
  'flashcards/list': {
    req: { deck?: string; query?: string };
    res: { cards: Flashcard[]; decks: FlashcardDeck[] };
  };
  /** The card to review now, or null when nothing is due and today's new cards are used up. */
  'flashcards/next': { req: { deck?: string }; res: { card: Flashcard | null; today: FlashcardToday } };
  'flashcards/grade': { req: { id: string; grade: FlashcardGrade }; res: { card: Flashcard; today: FlashcardToday } };
  'flashcards/create': { req: { input: FlashcardInput }; res: { card: Flashcard } };
  /** Omitted fields stay. Editing the text keeps the review. */
  'flashcards/update': { req: { id: string; patch: Partial<FlashcardInput> }; res: { card: Flashcard } };
  'flashcards/delete': { req: { id: string }; res: null };
  /** Markdown as in §17.3; `deck` names cards that come before any "# " heading. */
  'flashcards/import': {
    req: { text: string; deck?: string };
    res: { created: number; skipped: number };
  };
}
