import { expect, it, vi } from 'vitest';
import type { ChronicleEntry, Json, PluginStorage } from '@featherlog/contracts';
import { initialState } from './model';
import { openState } from './storage';

function fixture() {
  const data = new Map<string, Json>();
  const storage: PluginStorage = {
    async get<T extends Json>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    set: vi.fn(async (key, value) => { data.set(key, structuredClone(value)); }),
    delete: vi.fn(async key => { data.delete(key); }),
    keys: async () => [...data.keys()],
  };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { data, storage, log, open: () => openState(storage, log) };
}
const entries: ChronicleEntry[] = [
  { id: 'old', at: '2026-09-01T00:00:00.000Z', kind: 'title', titleId: 'first-stroke', titleName: '初落笔' },
  { id: 'new', at: '2026-10-01T00:00:00.000Z', kind: 'title', titleId: 'one-deed', titleName: '了却一桩' },
];

it('writes only affected monthly shards and reloads all committed state', async () => {
  const f = fixture();
  const opened = await f.open();
  await opened.save(initialState(), entries);
  vi.mocked(f.storage.set).mockClear();
  const next = { ...opened.state, initialized: true };
  const entry = { ...entries[1]!, id: 'next' };
  await opened.save(next, [entry]);
  expect(f.storage.set).toHaveBeenCalledTimes(2);
  expect(vi.mocked(f.storage.set).mock.calls[0]![0]).toMatch(/^chronicle:2026-10:/);
  const loaded = await f.open();
  expect(loaded.state).toEqual(next);
  expect(loaded.entries()).toEqual([...entries, entry]);
  expect(f.data.size).toBe(3);
});

it.each([1, 2, 3])('rolls back the whole transaction when write %i fails', async failure => {
  const f = fixture();
  const opened = await f.open();
  await opened.save(initialState(), []);
  const before = structuredClone(f.data);
  const set = vi.mocked(f.storage.set).getMockImplementation()!;
  let count = 0;
  vi.mocked(f.storage.set).mockImplementation(async (key, value) => {
    if (++count === failure) throw new Error('disk full');
    await set(key, value);
  });
  await expect(opened.save({ ...opened.state, initialized: true }, entries)).rejects.toThrow('disk full');
  expect(f.data).toEqual(before);
  expect(opened.entries()).toEqual([]);
  expect(opened.state.initialized).toBe(false);
  expect((await f.open()).state.initialized).toBe(false);
  await opened.save({ ...opened.state, initialized: true }, entries);
  expect((await f.open()).entries()).toEqual(entries);
});

it('does not expose staged shards while the index commit is pending', async () => {
  const f = fixture();
  const opened = await f.open();
  await opened.save(initialState(), []);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const set = vi.mocked(f.storage.set).getMockImplementation()!;
  vi.mocked(f.storage.set).mockImplementation(async (key, value) => {
    if (key === 'state') { reached(); await gate; }
    await set(key, value);
  });
  const saving = opened.save({ ...opened.state, initialized: true }, entries);
  await ready;
  expect(opened.entries()).toEqual([]);
  expect(opened.state.initialized).toBe(false);
  release(); await saving;
  expect(opened.entries()).toEqual(entries);
});

it('logs cleanup failures after commit and cleans crash orphans on restart', async () => {
  const f = fixture();
  const opened = await f.open();
  await opened.save(initialState(), entries);
  vi.mocked(f.storage.delete).mockRejectedValue(new Error('locked'));
  await opened.save(opened.state, [{ ...entries[1]!, id: 'next' }]);
  expect(f.log.warn).toHaveBeenCalled();
  expect(opened.entries()).toHaveLength(3);
  vi.mocked(f.storage.delete).mockImplementation(async key => { f.data.delete(key); });
  f.data.set('unrelated', 'keep');
  await f.open();
  expect(f.data.size).toBe(4);
  expect(f.data.get('unrelated')).toBe('keep');
});

it.each(['schema', 'rank', 'title', 'worn', 'account', 'missing', 'month', 'entry'])(
  'refuses corrupt %s without changing any data', async mode => {
    const f = fixture();
    const opened = await f.open();
    await opened.save(initialState(), entries);
    const stored = f.data.get('state') as { state: Record<string, Json>; months: { month: string; key: string }[] };
    if (mode === 'schema') stored.state.schemaVersion = 2;
    if (mode === 'rank') stored.state.ranks = [0, 0, 7, 0];
    if (mode === 'title') stored.state.titles = [];
    if (mode === 'worn') stored.state.worn = 'one-deed';
    if (mode === 'account') stored.state.accounts = [{ id: 'q' }];
    if (mode === 'missing') f.data.delete(stored.months[0]!.key);
    if (mode === 'month') stored.months[0]!.month = '2026-13';
    if (mode === 'entry') f.data.set(stored.months[0]!.key, [{ id: 'x', kind: 'other' }]);
    const before = structuredClone(f.data);
    vi.mocked(f.storage.delete).mockClear();
    await expect(f.open()).rejects.toMatchObject({ code: 'character/invalid-input' });
    expect(f.data).toEqual(before);
    expect(f.storage.delete).not.toHaveBeenCalled();
  },
);
