import type { Flashcard } from '@featherlog/contracts';
import { input, object, periodKey, valid } from './model';

export type State = {
  schemaVersion: 1;
  cards: Flashcard[];
  today: { periodKey: string; reviewed: number; fresh: number };
};
function integer(value: unknown): asserts value is number {
  valid(Number.isSafeInteger(value) && Number(value) >= 0, 'Invalid stored count');
}
function date(value: unknown): asserts value is string {
  valid(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Invalid stored date');
  const time = Date.parse(`${value}T00:00:00Z`);
  valid(Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value, 'Invalid stored date');
}
function timestamp(value: unknown): void {
  valid(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)), 'Invalid stored timestamp');
  date(value.slice(0, 10));
}
export function loadState(value: unknown, now: number): State {
  if (value === undefined) return { schemaVersion: 1, cards: [],
    today: { periodKey: periodKey(now, 4), reviewed: 0, fresh: 0 } };
  object(value);
  valid(value.schemaVersion === 1 && Array.isArray(value.cards), 'Invalid flashcards schema');
  object(value.today);
  date(value.today.periodKey);
  integer(value.today.reviewed); integer(value.today.fresh);
  valid(value.today.fresh <= value.today.reviewed, 'Invalid stored daily counts');
  const ids = new Set<string>();
  for (const card of value.cards) {
    object(card);
    const normalized = input(card);
    valid(Object.entries(normalized).every(([key, text]) => card[key] === text), 'Invalid stored card text');
    valid(typeof card.id === 'string' && card.id.length > 0 && !ids.has(card.id), 'Invalid or duplicate card id');
    ids.add(card.id); timestamp(card.createdAt); timestamp(card.updatedAt);
    object(card.review);
    const review = card.review;
    integer(review.box); integer(review.reviews); integer(review.lapses);
    valid(review.box <= 7 && review.lapses <= review.reviews, 'Invalid stored review');
    if (review.reviews === 0) {
      valid(review.box === 0 && review.lapses === 0 && review.due === undefined &&
        review.lastGrade === undefined && review.lastReviewedAt === undefined, 'Invalid new card review');
    } else {
      valid(['again', 'hard', 'good'].includes(String(review.lastGrade)), 'Invalid stored grade');
      timestamp(review.due); timestamp(review.lastReviewedAt);
    }
  }
  return value as unknown as State;
}
