import { expect, it } from 'vitest';
import { loadState, type State } from './storage';

const now = new Date('2026-10-05T12:00:00Z').getTime();
function stored(): State {
  return { schemaVersion: 1, today: { periodKey: '2026-10-05', reviewed: 1, fresh: 1 }, cards: [{
    id: 'card', deck: 'Redis', question: 'RDB?', answer: 'Snapshot',
    createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T01:00:00.000Z',
    review: { box: 1, reviews: 1, lapses: 0, due: '2026-10-06T04:00:00.000Z',
      lastReviewedAt: '2026-10-05T01:00:00.000Z', lastGrade: 'good' },
  }] };
}
it('loads reviewed and new records without migration or changes', () => {
  const state = stored();
  expect(loadState(state, now)).toEqual(state);
  state.cards[0]!.review = { box: 0, reviews: 0, lapses: 0 };
  expect(loadState(state, now)).toEqual(state);
  expect(loadState(undefined, now)).toMatchObject({ schemaVersion: 1, cards: [], today: { reviewed: 0, fresh: 0 } });
});
it.each([
  ['schema', (state: State) => Object.assign(state, { schemaVersion: 2 })],
  ['cards', (state: State) => Object.assign(state, { cards: null })],
  ['period', (state: State) => { state.today.periodKey = '2026-02-30'; }],
  ['counts', (state: State) => { state.today.reviewed = -1; }],
  ['fresh', (state: State) => { state.today.fresh = 2; }],
  ['deck', (state: State) => { state.cards[0]!.deck = 'd'.repeat(41); }],
  ['untrimmed', (state: State) => { state.cards[0]!.question = ' RDB? '; }],
  ['answer', (state: State) => { state.cards[0]!.answer = ''; }],
  ['id', (state: State) => { state.cards[0]!.id = ''; }],
  ['duplicate', (state: State) => { state.cards.push(structuredClone(state.cards[0]!)); }],
  ['createdAt', (state: State) => { state.cards[0]!.createdAt = 'yesterday'; }],
  ['impossible date', (state: State) => { state.cards[0]!.createdAt = '2026-02-30T00:00:00Z'; }],
  ['no timezone', (state: State) => { state.cards[0]!.createdAt = '2026-10-05T00:00:00'; }],
  ['box', (state: State) => { state.cards[0]!.review.box = 8; }],
  ['fraction', (state: State) => { state.cards[0]!.review.reviews = 1.5; }],
  ['lapses', (state: State) => { state.cards[0]!.review.lapses = 2; }],
  ['grade', (state: State) => { Object.assign(state.cards[0]!.review, { lastGrade: 'easy' }); }],
  ['due', (state: State) => { delete state.cards[0]!.review.due; }],
  ['lastReviewedAt', (state: State) => { delete state.cards[0]!.review.lastReviewedAt; }],
  ['new with history', (state: State) => { state.cards[0]!.review.reviews = 0; }],
] as const)('rejects corrupt %s without mutating the supplied record', (_, corrupt) => {
  const state = stored(); corrupt(state); const original = structuredClone(state);
  expect(() => loadState(state, now)).toThrow(expect.objectContaining({ code: 'flashcards/invalid-input' }));
  expect(state).toEqual(original);
});
