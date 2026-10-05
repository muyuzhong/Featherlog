import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '@featherlog/kernel';
import type { Clock, Envelope, FlashcardInput, FlashcardsRequests, Json, PluginStorage, RequestPayload, ResponseData } from '@featherlog/contracts';
import { setup } from './index';
import { periodKey } from './model';
import manifest from '../../manifest.json';

const local = (day = '2026-10-05', hour = 12, minute = 0) => new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).getTime();
async function fixture(options: { data?: Map<string, Json>; now?: number; noQuest?: boolean; hour?: number; newPerDay?: number } = {}) {
  let time = options.now ?? local();
  let hour = options.hour ?? 4;
  let newPerDay = options.newPerDay;
  const clock: Clock = { now: () => time, setTimeout: () => () => {} };
  const data = options.data ?? new Map<string, Json>();
  const storage: PluginStorage = {
    async get<T extends Json>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    set: vi.fn(async (key, value) => { data.set(key, structuredClone(value)); }),
    delete: vi.fn(async key => { data.delete(key); }), keys: async () => [...data.keys()],
  };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const kernel = createKernel({ clock, log, development: true, createServices: () => ({ clock, log, storage,
    settings: { get: <T extends Json>() => newPerDay as T | undefined, onChange: () => () => {} },
    secrets: { get: async () => undefined, onChange: () => () => {} },
  }) });
  const bus = kernel.createBus('shell');
  const messages: Envelope[] = [];
  kernel.observe(message => { messages.push(message); });
  const getPeriod = vi.fn(() => ({ periodKey: periodKey(time, hour), dayStartHour: hour }));
  const offQuest = options.noQuest ? () => {} : kernel.createBus('quest').handle('quest/period', getPeriod);
  await kernel.load([{ manifest, setup }]);
  const request = <K extends keyof FlashcardsRequests>(type: K, payload: RequestPayload<K>) =>
    bus.request(type, payload) as Promise<ResponseData<K>>;
  const create = async (input: FlashcardInput = { question: 'Question', answer: 'Answer' }) =>
    (await request('flashcards/create', { input })).card;
  const next = (deck?: string) => request('flashcards/next', deck === undefined ? {} : { deck });
  const list = () => request('flashcards/list', {});
  const events = () => messages.filter(m => m.kind === 'event' && m.type.startsWith('flashcards/'));
  return { kernel, bus, request, create, next, list, events, messages, data, storage, log, getPeriod, offQuest,
    failed: messages.find(m => m.type === 'kernel/plugin-failed'),
    setTime(value: number) { time = value; }, setHour(value: number) { hour = value; },
    setLimit(value: number) { newPerDay = value; },
  };
}

describe('§17.3 card library', () => {
  it('stores normalized plain text and keeps review progress while editing', async () => {
    const f = await fixture();
    let card = await f.create({ deck: ' Redis ', question: ' RDB?\nMore? ', answer: ' Snapshot\nDetails ' });
    expect(card).toMatchObject({ deck: 'Redis', question: 'RDB?\nMore?', answer: 'Snapshot\nDetails',
      review: { box: 0, reviews: 0, lapses: 0 }, createdAt: new Date(local()).toISOString() });
    expect(card.review).not.toHaveProperty('due');
    card = (await f.request('flashcards/grade', { id: card.id, grade: 'good' })).card;
    const review = structuredClone(card.review);
    f.setTime(local() + 1000);
    const updated = (await f.request('flashcards/update', { id: card.id, patch: { deck: '', question: ' New? ', answer: ' New answer ' } })).card;
    expect(updated).toMatchObject({ deck: '', question: 'New?', answer: 'New answer', review,
      createdAt: card.createdAt, updatedAt: new Date(local() + 1000).toISOString() });
    const count = f.events().length;
    await f.request('flashcards/update', { id: card.id, patch: {} });
    expect(f.events()).toHaveLength(count);
    const reloaded = await fixture({ data: f.data, now: local() + 1000 });
    expect((await reloaded.list()).cards).toEqual([updated]);
    await reloaded.request('flashcards/delete', { id: card.id });
    expect((await reloaded.list()).cards).toEqual([]);
    expect(reloaded.events().at(-1)).toMatchObject({ type: 'flashcards/deleted', payload: { id: card.id } });
    expect((await (await fixture({ data: f.data })).list()).cards).toEqual([]);
  });

  it('lists oldest first, searches question/answer case-insensitively and reports all decks', async () => {
    const f = await fixture();
    const first = await f.create({ deck: 'Redis', question: 'RDB?', answer: 'SNAPSHOT' });
    f.setTime(local() + 1000);
    const second = await f.create({ deck: 'redis', question: 'AOF?', answer: 'Log' });
    f.setTime(local() + 2000);
    const third = await f.create({ deck: '', question: 'snapshot restore?', answer: 'Read disk' });
    expect((await f.list()).cards.map(c => c.id)).toEqual([first.id, second.id, third.id]);
    expect((await f.request('flashcards/list', { query: 'snapshot' })).cards.map(c => c.id)).toEqual([first.id, third.id]);
    expect((await f.request('flashcards/list', { query: 'Redis' })).cards).toEqual([]);
    const selected = await f.request('flashcards/list', { deck: 'Redis' });
    expect(selected.cards.map(c => c.id)).toEqual([first.id]);
    expect(selected.decks).toHaveLength(3);
    expect((await f.request('flashcards/list', { deck: '' })).cards.map(c => c.id)).toEqual([third.id]);
    await f.request('flashcards/grade', { id: first.id, grade: 'again' });
    const decks = (await f.list()).decks;
    expect(decks.find(d => d.name === 'Redis')).toEqual({ name: 'Redis', total: 1, due: 1, fresh: 0 });
    expect(decks.find(d => d.name === 'redis')).toEqual({ name: 'redis', total: 1, due: 0, fresh: 1 });
  });

  it('rejects invalid input, patch, id, grade and filters without changing data', async () => {
    const f = await fixture(); const card = await f.create(); const before = structuredClone(f.data);
    const bad: Array<[keyof FlashcardsRequests, unknown]> = [
      ['flashcards/create', { input: { question: ' ', answer: 'a' } }],
      ['flashcards/update', { id: card.id, patch: { answer: null } }],
      ['flashcards/update', { id: card.id, patch: [] }],
      ['flashcards/delete', { id: '' }], ['flashcards/grade', { id: card.id, grade: 'easy' }],
      ['flashcards/list', { query: 1 }], ['flashcards/list', { deck: null }], ['flashcards/next', { deck: 1 }],
      ['flashcards/next', null], ['flashcards/import', { text: '## Q\nA', deck: 'd'.repeat(41) }],
    ];
    for (const [type, payload] of bad) await expect(f.request(type, payload as RequestPayload<typeof type>))
      .rejects.toMatchObject({ code: 'flashcards/invalid-input' });
    const absent = { id: 'absent', patch: {}, grade: 'good' as const };
    for (const type of ['flashcards/update', 'flashcards/delete', 'flashcards/grade'] as const) {
      await expect(f.request(type, absent))
        .rejects.toMatchObject({ code: 'flashcards/not-found' });
    }
    expect(f.data).toEqual(before);
    expect(f.events()).toHaveLength(1);
  });

  it('imports valid cards atomically and skips duplicates, empty answers and oversized cards', async () => {
    const f = await fixture();
    await f.create({ deck: 'Redis', question: 'Existing', answer: 'Old' });
    f.messages.length = 0;
    const source = ['## Existing', 'duplicate', '## New', 'answer', '## New', 'duplicate', '## Empty',
      '## Too long', 'x'.repeat(10001), '# Other', '### New', 'other answer'].join('\n');
    expect(await f.request('flashcards/import', { text: source, deck: 'Redis' })).toEqual({ created: 2, skipped: 4 });
    expect((await f.list()).cards).toHaveLength(3);
    expect(f.events()).toHaveLength(1);
    expect(f.events()[0]).toMatchObject({ type: 'flashcards/imported', payload: { created: 2 } });
    expect(f.events()[0]!.causedBy).toBe(f.messages.find(m => m.kind === 'request' && m.type === 'flashcards/import')!.id);
    const reloaded = await fixture({ data: f.data });
    expect((await reloaded.list()).cards).toEqual((await f.list()).cards);
    const before = structuredClone(f.data);
    await expect(f.request('flashcards/import', { text: '羽'.repeat(349526) })).rejects.toMatchObject({ code: 'flashcards/invalid-input' });
    expect(f.data).toEqual(before);
  });

  it('imports nothing on write failure and safely retries without losing concurrent creates', async () => {
    const f = await fixture(); await f.create(); const before = structuredClone(f.data);
    vi.mocked(f.storage.set).mockRejectedValueOnce(new Error('disk full'));
    await expect(f.request('flashcards/import', { text: '## One\nA\n## Two\nB' })).rejects.toThrow('disk full');
    expect(f.data).toEqual(before); expect((await f.list()).cards).toHaveLength(1);
    expect(f.events()).toHaveLength(1);
    await Promise.all([f.request('flashcards/import', { text: '## One\nA\n## Two\nB' }), f.create({ question: 'Third', answer: 'C' })]);
    expect((await f.list()).cards).toHaveLength(4);
    expect((await f.request('flashcards/import', { text: '## One\nA\n## Two\nB' })).skipped).toBe(2);
  });
});

describe('§17.4 due order and global daily counts', () => {
  it('returns overdue cards before fresh cards, ordered by due date and inclusive of now', async () => {
    const f = await fixture();
    const late = await f.create({ question: 'late', answer: 'a' });
    const early = await f.create({ question: 'early', answer: 'a' });
    const fresh = await f.create({ question: 'fresh', answer: 'a' });
    await f.request('flashcards/grade', { id: early.id, grade: 'again' });
    f.setTime(local() + 1000);
    await f.request('flashcards/grade', { id: late.id, grade: 'again' });
    expect((await f.next()).card!.id).toBe(fresh.id);
    f.setTime(local() + 600_000);
    expect((await f.next()).card!.id).toBe(early.id);
    f.setTime(local() + 601_000);
    expect((await f.next()).card!.id).toBe(early.id);
    await f.request('flashcards/grade', { id: early.id, grade: 'good' });
    expect((await f.next()).card!.id).toBe(late.id);
  });

  it('counts first grades, not next calls; limits fresh cards globally, even across decks', async () => {
    const f = await fixture({ newPerDay: 1 });
    const first = await f.create({ deck: 'A', question: 'one', answer: 'a' });
    f.setTime(local() + 1000);
    const second = await f.create({ deck: 'B', question: 'two', answer: 'a' });
    expect((await f.next()).card!.id).toBe(first.id);
    expect((await f.next()).card!.id).toBe(first.id);
    expect((await f.next('B')).today).toEqual({ reviewed: 0, remaining: 1 });
    await f.request('flashcards/grade', { id: first.id, grade: 'good' });
    expect(await f.next('B')).toEqual({ card: null, today: { reviewed: 1, remaining: 0 } });
    // Manual grading is allowed even when a card is not due or the new-card allowance is exhausted.
    await f.request('flashcards/grade', { id: second.id, grade: 'good' });
    await f.request('flashcards/grade', { id: first.id, grade: 'hard' });
    expect((await f.next()).today).toEqual({ reviewed: 3, remaining: 0 });
    expect((f.data.get('state') as { today: { fresh: number } }).today.fresh).toBe(2);
  });

  it('uses default ten new cards, allows zero and reads setting changes immediately', async () => {
    const f = await fixture();
    for (let i = 0; i < 12; i++) await f.create({ question: String(i), answer: 'A' });
    expect((await f.next()).today.remaining).toBe(10);
    f.setLimit(0); expect(await f.next()).toEqual({ card: null, today: { reviewed: 0, remaining: 0 } });
    f.setLimit(2); expect((await f.next()).today.remaining).toBe(2);
    f.setLimit(-1); await expect(f.next()).rejects.toMatchObject({ code: 'flashcards/invalid-input' });
  });

  it('does not show a learning card early and includes it in remaining only before today ends', async () => {
    const f = await fixture({ now: local('2026-10-05', 3, 40) });
    const card = await f.create();
    expect((await f.request('flashcards/grade', { id: card.id, grade: 'again' })).today).toEqual({ reviewed: 1, remaining: 1 });
    expect((await f.next()).card).toBeNull();
    f.setTime(local('2026-10-05', 3, 50));
    expect((await f.next()).card!.id).toBe(card.id);
    expect((await f.request('flashcards/grade', { id: card.id, grade: 'again' })).today).toEqual({ reviewed: 2, remaining: 0 });
    expect((await f.list()).decks[0]!.due).toBe(0);
    f.setTime(local('2026-10-05', 4));
    expect((await f.next()).today).toEqual({ reviewed: 0, remaining: 1 });
    expect((await f.next()).card!.id).toBe(card.id);
  });

  it.each([true, false])('resets counts at the day boundary and after sleep (noQuest=%s)', async noQuest => {
    const hour = noQuest ? 4 : 7;
    const f = await fixture({ noQuest, hour, now: local('2026-10-05', hour - 1), newPerDay: 1 });
    const card = await f.create(); await f.create({ question: 'other', answer: 'a' });
    const result = await f.request('flashcards/grade', { id: card.id, grade: 'good' });
    expect(result.card.review.due).toBe(new Date(local('2026-10-05', hour)).toISOString());
    expect(result.today).toEqual({ reviewed: 1, remaining: 0 });
    const reloaded = await fixture({ data: f.data, noQuest, hour, now: local('2026-10-05', hour - 1), newPerDay: 1 });
    expect((await reloaded.next()).today.reviewed).toBe(1);
    reloaded.setTime(local('2026-10-05', hour));
    expect((await reloaded.next()).today).toEqual({ reviewed: 0, remaining: 2 });
    await reloaded.request('flashcards/grade', { id: card.id, grade: 'good' });
    reloaded.setTime(local('2026-10-09', hour + 1));
    expect((await reloaded.next()).today).toEqual({ reviewed: 0, remaining: 2 });
    expect((await reloaded.next()).card!.id).toBe(card.id);
    if (!noQuest) expect(reloaded.getPeriod).toHaveBeenCalled();
  });

  it('consults quest after ready, responds to boundary changes and falls back only on no-handler', async () => {
    const f = await fixture({ hour: 4, now: local('2026-10-05', 5) });
    expect(f.messages.some(m => m.type === 'quest/period')).toBe(false);
    const card = await f.create();
    await f.request('flashcards/grade', { id: card.id, grade: 'good' });
    f.setHour(6);
    expect((await f.next()).today.reviewed).toBe(0);
    const before = structuredClone(f.data);
    f.getPeriod.mockImplementationOnce(() => { throw new Error('temporarily unavailable'); });
    await expect(f.next()).rejects.toThrow('temporarily unavailable');
    expect(f.data).toEqual(before);
    f.offQuest();
    await f.next();
    expect((f.data.get('state') as { today: { periodKey: string } }).today.periodKey).toBe('2026-10-05');
  });

  it('persists every reviewed count, retains it on deletion and leaves it unchanged on failed grades', async () => {
    const f = await fixture(); const card = await f.create();
    await Promise.all([f.request('flashcards/grade', { id: card.id, grade: 'good' }), f.request('flashcards/grade', { id: card.id, grade: 'again' })]);
    expect((await f.next()).today.reviewed).toBe(2);
    expect((await f.list()).cards[0]!.review).toMatchObject({ reviews: 2, box: 0, lapses: 1 });
    const before = structuredClone(f.data);
    vi.mocked(f.storage.set).mockRejectedValueOnce(new Error('disk full'));
    await expect(f.request('flashcards/grade', { id: card.id, grade: 'hard' })).rejects.toThrow('disk full');
    expect(f.data).toEqual(before); expect((await f.next()).today.reviewed).toBe(2);
    await f.request('flashcards/delete', { id: card.id });
    expect(await f.next()).toEqual({ card: null, today: { reviewed: 2, remaining: 0 } });
    const reloaded = await fixture({ data: f.data });
    expect((await reloaded.next()).today.reviewed).toBe(2);
  });
});

it('does not repeat events or writes on another kernel/ready and cleans handlers on unload', async () => {
  const f = await fixture(); const card = await f.create();
  await f.request('flashcards/grade', { id: card.id, grade: 'good' });
  const before = structuredClone(f.data); const events = f.events();
  vi.mocked(f.storage.set).mockClear();
  await f.kernel.load([]); await f.next();
  expect(f.data).toEqual(before); expect(f.events()).toEqual(events); expect(f.storage.set).not.toHaveBeenCalled();
  f.kernel.unload('flashcards');
  await expect(f.next()).rejects.toMatchObject({ code: 'no-handler' });
  await f.kernel.load([{ manifest, setup }]);
  expect((await f.list()).cards[0]!.review.reviews).toBe(1);
});

it('rejects damaged storage before registering handlers or writing', async () => {
  const data = new Map<string, Json>([['state', { schemaVersion: 2 }]]);
  const before = structuredClone(data); const f = await fixture({ data });
  expect(f.failed).toBeDefined(); expect(data).toEqual(before);
  expect(f.storage.set).not.toHaveBeenCalled();
  await expect(f.next()).rejects.toMatchObject({ code: 'no-handler' });
});

it('keeps a queued reader on the old library until an import commits', async () => {
  const f = await fixture(); await f.create();
  const before = structuredClone(f.data);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const set = vi.mocked(f.storage.set).getMockImplementation()!;
  vi.mocked(f.storage.set).mockImplementationOnce(async (key, value) => {
    entered(); await pending; await set(key, value);
  });
  const writing = f.request('flashcards/import', { text: '## One\nA\n## Two\nB' });
  await reached;
  let read = false;
  const reading = f.list().then(value => { read = true; return value; });
  await Promise.resolve();
  expect(read).toBe(false); expect(f.data).toEqual(before); expect(f.events()).toHaveLength(1);
  release(); await writing;
  expect((await reading).cards).toHaveLength(3);
});

it('suppresses late events when an in-flight write completes after unloading', async () => {
  const f = await fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const set = vi.mocked(f.storage.set).getMockImplementation()!;
  vi.mocked(f.storage.set).mockImplementationOnce(async (key, value) => {
    entered(); await pending; await set(key, value);
  });
  const writing = f.create().catch(cause => cause);
  await reached; f.kernel.unload('flashcards'); release(); await writing; await Promise.resolve();
  expect(f.events()).toEqual([]);
  await f.kernel.load([{ manifest, setup }]);
  expect((await f.list()).cards).toHaveLength(1);
});
