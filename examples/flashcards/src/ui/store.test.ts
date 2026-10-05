import type { Flashcard, FlashcardToday, UiBus, UiSound } from '@featherlog/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createFlashcardsStore, nextSpan } from './store';

const card = (review: Flashcard['review']): Flashcard => ({
  id: 'c1', deck: '', question: '问', answer: '答', review,
  createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
});

describe('nextSpan (design §17.4)', () => {
  it('sends a new card to 10 minutes, the first day, or the first day', () => {
    const fresh = card({ box: 0, reviews: 0, lapses: 0 });
    expect(['again', 'hard', 'good'].map((g) => nextSpan(fresh, g as never))).toEqual(['10 分钟后', '1 天后', '1 天后']);
  });

  it('keeps a forgotten card in the first box when it is only 模糊', () => {
    const forgotten = card({ box: 0, reviews: 3, lapses: 1, due: '2026-10-05T00:10:00.000Z' });
    expect(nextSpan(forgotten, 'hard')).toBe('10 分钟后');
    expect(nextSpan(forgotten, 'good')).toBe('1 天后');
  });

  it('moves a known card up one box, never past the last', () => {
    expect(nextSpan(card({ box: 3, reviews: 5, lapses: 0, due: '2026-10-05T00:00:00.000Z' }), 'good')).toBe('7 天后');
    expect(nextSpan(card({ box: 3, reviews: 5, lapses: 0, due: '2026-10-05T00:00:00.000Z' }), 'hard')).toBe('4 天后');
    expect(nextSpan(card({ box: 7, reviews: 9, lapses: 0, due: '2026-10-05T00:00:00.000Z' }), 'good')).toBe('60 天后');
  });
});

/** A bus whose "flashcards/next" answers with whatever the test sets; `emit` delivers events. */
function fakeBus() {
  const answer: { card: Flashcard | null; today: FlashcardToday } = { card: null, today: { reviewed: 0, remaining: 0 } };
  const listeners = new Map<string, (payload: unknown) => void>();
  const bus = {
    request: vi.fn(async (type: string) => {
      if (type === 'flashcards/next') return structuredClone(answer);
      if (type === 'flashcards/list') return { cards: [], decks: [] };
      throw new Error(`unexpected ${type}`);
    }),
    on: vi.fn((type: string, listener: (payload: unknown) => void) => {
      listeners.set(type, listener);
      return () => listeners.delete(type);
    }),
  };
  return { bus: bus as unknown as UiBus, answer, emit: (type: string, payload: unknown) => listeners.get(type)?.(payload) };
}
const sound = { play: vi.fn() } as unknown as UiSound;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const fresh = (id: string) => ({ ...card({ box: 0, reviews: 0, lapses: 0 }), id });

describe('the scroll card stays current (design §17.5)', () => {
  it('updates the counts after an import and keeps the card being read', async () => {
    const { bus, answer, emit } = fakeBus();
    answer.card = fresh('q1');
    answer.today = { reviewed: 0, remaining: 8 };
    const store = createFlashcardsStore(bus, sound);
    await settle();
    answer.today = { reviewed: 0, remaining: 10 };
    emit('flashcards/imported', { created: 2 });
    await settle();
    expect(store.getSnapshot().current?.id).toBe('q1');
    expect(store.getSnapshot().today).toEqual({ reviewed: 0, remaining: 10 });
  });

  it('keeps a card whose answer is showing, but takes the schedule\'s card otherwise', async () => {
    const { bus, answer } = fakeBus();
    answer.card = fresh('q8');
    answer.today = { reviewed: 6, remaining: 5 };
    const store = createFlashcardsStore(bus, sound);
    await settle();

    // A new day: an older card is due first, and yesterday's count is gone.
    answer.card = fresh('q1');
    answer.today = { reviewed: 0, remaining: 9 };
    store.flip();
    store.refresh();
    await settle();
    expect(store.getSnapshot()).toMatchObject({ current: { id: 'q8' }, flipped: true, today: { reviewed: 0, remaining: 9 } });

    const unflipped = createFlashcardsStore(bus, sound);
    await settle();
    answer.card = fresh('q4');
    unflipped.refresh();
    await settle();
    expect(unflipped.getSnapshot()).toMatchObject({ current: { id: 'q4' }, flipped: false });
  });
});
