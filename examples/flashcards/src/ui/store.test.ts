import type { Flashcard } from '@featherlog/contracts';
import { describe, expect, it } from 'vitest';
import { nextSpan } from './store';

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
