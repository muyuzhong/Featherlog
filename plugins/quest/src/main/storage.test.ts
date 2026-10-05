import { expect, it, vi } from 'vitest';
import type { Json, PluginStorage } from '@featherlog/contracts';
import type { State, StoredQuest } from './model';
import { openState } from './storage';

const period = '2026-09-28';
const quest = (id: string): StoredQuest => ({
  id, kind: 'daily', title: id, status: 'active', priority: 'none', tracked: false,
  revealed: false, chapters: [], order: 0, recurrence: { freq: 'daily' },
  cycle: { periodKey: period, current: 0, done: true },
  createdAt: `${period}T12:00:00.000Z`, updatedAt: `${period}T12:00:00.000Z`,
});
const legacy = (): State => ({ schemaVersion: 1, quests: [quest('a'), quest('b')],
  history: { a: [period], b: [period] }, meta: { lastPeriodKey: period } });
function fixture(initial: State = legacy()) {
  const data = new Map<string, Json>([['state', structuredClone(initial) as unknown as Json]]);
  const storage: PluginStorage = {
    async get<T extends Json>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    set: vi.fn(async (key, value) => { data.set(key, structuredClone(value)); }),
    delete: vi.fn(async key => { data.delete(key); }),
    async keys() { return [...data.keys()]; },
  };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { data, storage, log, open: () => openState(storage, log, period) };
}
const updated = (state: State): State => ({ ...state,
  quests: state.quests.map(item => ({ ...item, cycle: { ...item.cycle!, done: false } })),
  history: { a: [], b: [] },
});

it('migrates all data atomically, keeps order, and reopens the new format', async () => {
  const f = fixture();
  const opened = await f.open();
  expect(opened.state).toEqual(legacy());
  expect((await f.open()).state).toEqual(legacy());
  expect(f.data.get('state')).toMatchObject({ schemaVersion: 2, meta: legacy().meta });
  expect(f.storage.set).toHaveBeenCalledTimes(3);
  expect([...f.data.keys()]).toHaveLength(3);
});

it('preserves optional chapter deadlines through legacy migration and indexed reads', async () => {
  const initial = legacy();
  const main = initial.quests[0]!;
  main.kind = 'main';
  delete main.recurrence;
  delete main.cycle;
  main.chapters = [
    { id: 'chapter-a', title: 'Book A', deadline: '2026-09-28',
      objectives: [{ id: 'objective-a', text: 'Read A' }] },
    { id: 'chapter-b', title: 'Book B', objectives: [{ id: 'objective-b', text: 'Read B' }] },
  ];
  const f = fixture(initial);
  expect((await f.open()).state).toEqual(initial);
  expect((await f.open()).state).toEqual(initial);
});

it.each([1, 2])('rejects invalid stored chapter dates in schemaVersion=%i without overwriting', async version => {
  const initial = legacy();
  const main = initial.quests[0]!;
  main.kind = 'main';
  delete main.recurrence;
  delete main.cycle;
  main.chapters = [{ id: 'chapter', title: 'Book', deadline: '2026-09-28',
    objectives: [{ id: 'objective', text: 'Read' }] }];
  const f = fixture(initial);
  if (version === 1) {
    main.chapters[0]!.deadline = '2026-02-29';
    f.data.set('state', structuredClone(initial) as unknown as Json);
  } else {
    await f.open();
    const index = f.data.get('state') as { quests: { id: string; key: string }[] };
    const key = index.quests.find(quest => quest.id === main.id)!.key;
    const record = f.data.get(key) as unknown as { quest: StoredQuest; history: string[] };
    record.quest.chapters[0]!.deadline = '2026-02-29';
  }
  const saved = structuredClone(f.data);
  await expect(f.open()).rejects.toMatchObject({ code: 'quest/invalid-input' });
  expect(f.data).toEqual(saved);
});

it.each([1, 2, 3])('preserves legacy data when migration write %i fails', async failure => {
  const f = fixture();
  const original = structuredClone(f.data);
  const set = vi.mocked(f.storage.set).getMockImplementation()!;
  let count = 0;
  vi.spyOn(f.storage, 'set').mockImplementation(async (key, value) => {
    if (++count === failure) throw new Error('disk full');
    await set(key, value);
  });
  await expect(f.open()).rejects.toThrow('disk full');
  expect(f.data).toEqual(original);
});

it.each([1, 2, 3])('rolls back multi-quest updates when write %i fails, then allows retry', async failure => {
  const f = fixture();
  const opened = await f.open();
  const previous = opened.state;
  const next = updated(previous);
  const original = structuredClone(f.data);
  const set = vi.mocked(f.storage.set).getMockImplementation()!;
  let count = 0;
  vi.spyOn(f.storage, 'set').mockImplementation(async (key, value) => {
    if (++count === failure) throw new Error('disk full');
    await set(key, value);
  });
  await expect(opened.save(next)).rejects.toThrow('disk full');
  expect(opened.state).toBe(previous);
  expect(f.data).toEqual(original);
  expect((await f.open()).state).toEqual(legacy());
  await opened.save(next);
  expect(opened.state).toBe(next);
  expect((await f.open()).state).toEqual(updated(legacy()));
});

it('leaves readers on the old state until the index write has completed', async () => {
  const f = fixture();
  const opened = await f.open();
  const previous = opened.state;
  const next = updated(previous);
  const set = vi.mocked(f.storage.set).getMockImplementation()!;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let atIndex!: () => void;
  const reached = new Promise<void>(resolve => { atIndex = resolve; });
  vi.spyOn(f.storage, 'set').mockImplementation(async (key, value) => {
    if (key === 'state') { atIndex(); await pending; }
    await set(key, value);
  });
  let finished = false;
  const saving = opened.save(next).then(() => { finished = true; });
  await reached;
  expect(finished).toBe(false);
  expect(opened.state).toBe(previous);
  expect(f.data.get('state')).toMatchObject({ schemaVersion: 2 });
  const index = f.data.get('state') as { quests: { key: string }[] };
  for (const reference of index.quests) {
    expect(f.data.get(reference.key)).toMatchObject({ history: [period] });
  }
  release();
  await saving;
  expect(opened.state).toBe(next);
  expect((await f.open()).state).toEqual(updated(legacy()));
});

it('commits despite cleanup failure and removes crash orphans on the next startup', async () => {
  const f = fixture();
  const opened = await f.open();
  vi.spyOn(f.storage, 'delete').mockRejectedValue(new Error('locked'));
  await opened.save(updated(opened.state));
  expect(opened.state).toEqual(updated(legacy()));
  expect([...f.data.keys()]).toHaveLength(5);
  expect(f.log.warn).toHaveBeenCalled();
  vi.spyOn(f.storage, 'delete').mockImplementation(async key => { f.data.delete(key); });
  f.data.set('unrelated', { retained: true });
  expect((await f.open()).state).toEqual(updated(legacy()));
  expect([...f.data.keys()]).toHaveLength(4);
  expect(f.data.has('unrelated')).toBe(true);
});

it('does not rewrite unchanged quests, even when their contents are large', async () => {
  const initial = legacy();
  initial.quests = Array.from({ length: 200 }, (_, index) => ({
    ...quest(String(index)), story: 'x'.repeat(2000),
  }));
  initial.history = {};
  const f = fixture(initial);
  const opened = await f.open();
  const next = { ...opened.state, quests: opened.state.quests.map((item, index) =>
    index === 0 ? { ...item, title: 'Changed' } : item) };
  vi.mocked(f.storage.set).mockClear();
  await opened.save(next);
  expect(f.storage.set).toHaveBeenCalledTimes(2);
  const writes = vi.mocked(f.storage.set).mock.calls;
  expect(writes[0]![1]).toMatchObject({ quest: { id: '0' } });
  expect(writes.reduce((bytes, [, value]) => bytes + JSON.stringify(value).length, 0))
    .toBeLessThan(JSON.stringify(next).length / 10);
  expect((await f.open()).state.quests).toEqual(next.quests);
});

it('bounds concurrent record reads, preserves index order and validates before cleanup', async () => {
  const initial = legacy();
  initial.quests = Array.from({ length: 35 }, (_, index) => quest(String(index)));
  initial.history = {};
  const f = fixture(initial);
  await f.open();
  const get = f.storage.get.bind(f.storage);
  let active = 0;
  let maximum = 0;
  vi.spyOn(f.storage, 'get').mockImplementation(async <T extends Json>(key: string) => {
    if (key === 'state') return get<T>(key);
    active++;
    maximum = Math.max(maximum, active);
    try { return await get<T>(key); }
    finally { active--; }
  });
  expect((await f.open()).state.quests).toEqual(initial.quests);
  expect(maximum).toBe(16);
  expect(active).toBe(0);
  vi.mocked(f.storage.delete).mockClear();
  const index = f.data.get('state') as { quests: { key: string }[] };
  f.data.delete(index.quests[20]!.key);
  await expect(f.open()).rejects.toMatchObject({ code: 'quest/invalid-input' });
  expect(f.storage.delete).not.toHaveBeenCalled();
});

it('keeps index order when parallel record reads finish in reverse order', async () => {
  const f = fixture();
  await f.open();
  const get = f.storage.get.bind(f.storage);
  const waiting = new Map<string, () => void>();
  vi.spyOn(f.storage, 'get').mockImplementation(async <T extends Json>(key: string) => {
    if (key !== 'state') await new Promise<void>(resolve => { waiting.set(key, resolve); });
    return get<T>(key);
  });
  const reading = f.open();
  await vi.waitFor(() => expect(waiting.size).toBe(2));
  for (const release of [...waiting.values()].reverse()) release();
  expect((await reading).state.quests.map(item => item.id)).toEqual(['a', 'b']);
});

it.each(['missing', 'mismatch', 'history', 'duplicate', 'version'])('preserves corrupt data (%s)', async mode => {
  const f = fixture();
  await f.open();
  const index = f.data.get('state') as { schemaVersion: number; quests: { id: string; key: string }[] };
  const key = index.quests[0]!.key;
  if (mode === 'missing') f.data.delete(key);
  if (mode === 'mismatch') f.data.set(key, { quest: quest('other'), history: [] } as unknown as Json);
  if (mode === 'history') f.data.set(key, { quest: quest('a'), history: null } as unknown as Json);
  if (mode === 'duplicate') index.quests.push(index.quests[0]!);
  if (mode === 'version') index.schemaVersion = 3;
  const saved = structuredClone(f.data);
  await expect(f.open()).rejects.toMatchObject({ code: 'quest/invalid-input' });
  expect(f.data).toEqual(saved);
});

it('preserves attributes through legacy migration and indexed reloads', async () => {
  const initial = legacy();
  initial.quests[0]!.attributes = ['body', 'mind'];
  const f = fixture(initial);
  expect((await f.open()).state).toEqual(initial);
  expect((await f.open()).state).toEqual(initial);
});

it.each([1, 2])('rejects corrupt stored attributes in schemaVersion=%i without writes', async version => {
  const f = fixture();
  if (version === 2) await f.open();
  const state = f.data.get('state') as { quests: Array<{ key?: string; attributes?: unknown }> };
  const reference = state.quests[0]!;
  const quest = version === 1 ? reference
    : (f.data.get(reference.key!) as { quest: { attributes?: unknown } }).quest;
  quest.attributes = ['learning', 'learning'];
  const before = structuredClone(f.data);
  await expect(f.open()).rejects.toMatchObject({ code: 'quest/invalid-input' });
  expect(f.data).toEqual(before);
});
