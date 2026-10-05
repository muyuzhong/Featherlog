import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '@featherlog/kernel';
import type {
  CharacterRequests, Clock, Envelope, EventPayload, Json, PluginStorage, Quest, QuestEvents,
  RequestPayload, ResponseData, ScribeEpilogue,
} from '@featherlog/contracts';
import { setup } from './index';

const local = (day = '2026-10-05', hour = 12) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).getTime();
const iso = (day = '2026-10-05', hour = 12) => new Date(local(day, hour)).toISOString();
function quest(patch: Partial<Quest> = {}): Quest {
  return { id: 'q', kind: 'main', title: 'Learn', status: 'active', priority: 'none', tracked: false,
    revealed: false, chapters: [{ id: 'c', title: 'Book', objectives: [{ id: 'o', text: 'Read' },
      { id: 'n', text: 'Count', count: { current: 0, target: 5 } }] }],
    order: 0, createdAt: iso(), updatedAt: iso(), attributes: ['learning'],
    derived: { chapterIndex: 0, objectiveIndex: 0, ratio: 0, chapterRatio: 0, streak: 0, dueToday: false, overdue: false }, ...patch };
}
function complete(source = quest()): Quest {
  const result = structuredClone(source);
  result.status = 'completed'; result.completedAt = iso();
  for (const chapter of result.chapters) {
    chapter.doneAt = iso();
    for (const objective of chapter.objectives) {
      objective.doneAt = iso();
      if (objective.count) objective.count.current = objective.count.target;
    }
  }
  return result;
}
async function fixture(options: { quests?: Quest[]; data?: Map<string, Json>; notifyFails?: boolean;
  now?: number; hour?: number; order?: 'early' | 'late' } = {}) {
  let time = options.now ?? local();
  let hour = options.hour ?? 4;
  let quests = structuredClone(options.quests ?? [quest()]);
  const clock: Clock = { now: () => time, setTimeout: () => () => {} };
  const data = options.data ?? new Map<string, Json>();
  const storage: PluginStorage = {
    async get<T extends Json>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    set: vi.fn(async (key, value) => { data.set(key, structuredClone(value)); }),
    delete: vi.fn(async key => { data.delete(key); }), keys: async () => [...data.keys()],
  };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const kernel = createKernel({ development: true, clock, log, createServices: () => ({ clock, storage, log,
    settings: { get: () => undefined, onChange: () => () => {} }, secrets: { get: async () => undefined, onChange: () => () => {} } }) });
  const shell = kernel.createBus('shell');
  const source = kernel.createBus('quest');
  const messages: Envelope[] = [];
  kernel.observe(envelope => { messages.push(envelope); });
  const notify = vi.fn(() => { if (options.notifyFails) throw new Error('unavailable'); return null; });
  shell.handle('shell/notify', notify);
  const character = { manifest: { id: 'character', name: 'Character', version: '1' }, setup };
  const provider = { manifest: { id: 'quest', name: 'Quest', version: '1' }, setup: () => {
    source.handle('quest/list', () => ({ quests }));
    source.handle('quest/period', () => {
      const date = new Date(time - hour * 3_600_000);
      return { periodKey: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, dayStartHour: hour };
    });
  } };
  await kernel.load(options.order === 'early' ? [character, provider] : [provider, character]);
  const request = <K extends keyof CharacterRequests>(type: K, payload: RequestPayload<K>) =>
    shell.request(type, payload) as Promise<ResponseData<K>>;
  const failed = messages.find(message => message.type === 'kernel/plugin-failed');
  if (!failed) await request('character/sheet', {});
  const sheet = () => request('character/sheet', {});
  const chronicle = () => request('character/chronicle', {});
  const emit = async <K extends keyof QuestEvents>(type: K, payload: QuestEvents[K], update = true) => {
    if (update && 'quest' in payload) {
      quests = [...quests.filter(quest => quest.id !== payload.quest.id), structuredClone(payload.quest)];
    }
    if (type === 'quest/deleted' && 'id' in payload) quests = quests.filter(quest => quest.id !== payload.id);
    source.emit(type, payload as EventPayload<K>);
    await Promise.resolve();
    return sheet();
  };
  const gift = async (epilogue: ScribeEpilogue) => {
    kernel.createBus('scribe').emit('scribe/epilogue-written', { epilogue });
    await Promise.resolve();
    return sheet();
  };
  return { kernel, request, sheet, chronicle, emit, gift, messages, notify, storage, data, log, failed,
    setQuests(value: Quest[]) { quests = structuredClone(value); },
    setTime(value: number) { time = value; }, setHour(value: number) { hour = value; } };
}

const points = (value: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['sheet']>>) => value.attributes.map(a => a.points);

describe('§16.9 snapshots, reconciliation and startup', () => {
  it.each(['early', 'late'] as const)('waits for kernel/ready when loaded %s', async order => {
    const f = await fixture({ quests: [complete()], order });
    expect(points(await f.sheet())).toEqual([105, 0, 0, 0]);
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.messages.filter(m => m.type === 'character/milestone')).toEqual([]);
    expect((await f.chronicle()).entries.filter(e => e.kind.endsWith('completed')).every(e => e.at === iso())).toBe(true);
  });

  it('matches full completion, incremental, duplicate, skipped and out-of-order snapshots', async () => {
    const done = complete();
    const partial = quest(); partial.chapters[0]!.objectives[0]!.doneAt = iso();
    const f = await fixture();
    await f.emit('quest/objective-completed', { quest: partial, chapterId: 'c', objectiveId: 'o' });
    await f.emit('quest/completed', { quest: done });
    const expected = await f.sheet();
    const count = (await f.chronicle()).entries.length;
    for (const snapshot of [partial, done, quest(), done]) {
      await f.emit('quest/updated', { quest: snapshot, changed: [] }, false);
    }
    expect(await f.sheet()).toEqual(expected);
    expect((await f.chronicle()).entries).toHaveLength(count);
    const skipped = await fixture();
    await skipped.emit('quest/completed', { quest: done });
    expect(await skipped.sheet()).toEqual(expected);
    const backfill = await fixture({ quests: [done] });
    expect(await backfill.sheet()).toEqual(expected);
    expect((await backfill.chronicle()).entries.filter(e => e.kind.endsWith('completed'))
      .map(({ id: _id, ...e }) => e).sort((a, b) => a.kind.localeCompare(b.kind)))
      .toEqual((await f.chronicle()).entries.filter(e => e.kind.endsWith('completed'))
        .map(({ id: _id, ...e }) => e).sort((a, b) => a.kind.localeCompare(b.kind)));
  });

  it('retains count peaks and completion rewards through undo and restart', async () => {
    const f = await fixture();
    const done = complete();
    await f.emit('quest/completed', { quest: done });
    const reset = quest(); reset.chapters[0]!.objectives[1]!.count!.current = 1;
    await f.emit('quest/uncompleted', { quest: reset });
    const restarted = await fixture({ quests: [reset], data: f.data });
    expect(points(await restarted.sheet())[0]).toBe(105);
    expect(restarted.notify).not.toHaveBeenCalled();
    await restarted.emit('quest/completed', { quest: done });
    expect(points(await restarted.sheet())[0]).toBe(105);
    const increased = complete(); increased.chapters[0]!.objectives[1]!.count!.current = 50;
    await restarted.emit('quest/counted', { quest: increased, previous: 5, current: 50, objectiveId: 'n' });
    expect(points(await restarted.sheet())[0]).toBe(150);
  });

  it('reattributes existing points from authoritative snapshots and freezes last known attributes on deletion', async () => {
    const f = await fixture({ quests: [complete()] });
    const moved = complete(quest({ attributes: ['body', 'mind'] }));
    await f.emit('quest/updated', { quest: moved, changed: ['attributes'] });
    expect(points(await f.sheet())).toEqual([0, 53, 52, 0]);
    expect((await f.sheet()).attributes[0]!.rank).toBe(2);
    await f.emit('quest/updated', { quest: complete(), changed: [] }, false);
    expect(points(await f.sheet())).toEqual([0, 53, 52, 0]);
    await f.emit('quest/deleted', { id: 'q' });
    await f.emit('quest/completed', { quest: complete() }, false);
    expect(points(await f.sheet())).toEqual([0, 53, 52, 0]);
    const restarted = await fixture({ data: f.data, quests: [] });
    expect(points(await restarted.sheet())).toEqual([0, 53, 52, 0]);
    expect((await restarted.chronicle()).entries.filter(e => e.kind === 'quest-completed')).toHaveLength(1);
  });

  it('recovers missed changes and daily periods when period-rolled/tracked events lack snapshots', async () => {
    const daily = quest({ kind: 'daily', chapters: [], recurrence: { freq: 'weekly', weekdays: [1, 3, 5] },
      cycle: { periodKey: '2026-10-05', current: 1, done: true }, attributes: [] });
    daily.derived.streak = 7;
    const f = await fixture({ quests: [daily] });
    expect((await f.sheet()).unassigned).toBe(35);
    daily.cycle = { periodKey: '2026-10-07', current: 0, done: false };
    f.setQuests([daily]); f.setTime(local('2026-10-07'));
    await f.emit('quest/period-rolled', { previous: '2026-10-05', current: '2026-10-07' });
    expect((await f.sheet()).unassigned).toBe(35);
    daily.cycle.done = true; daily.derived.streak = 8;
    f.setQuests([daily]);
    await f.emit('quest/tracked', { questId: 'q', previous: null });
    expect((await f.sheet()).unassigned).toBe(40);
    await f.emit('quest/completed', { quest: daily, periodKey: '2026-10-07' });
    expect((await f.sheet()).unassigned).toBe(40);
    expect((await f.chronicle()).entries.every(e => e.kind === 'title')).toBe(true);
  });

  it('backfills historical timestamps and records newly earned titles at the injected current time', async () => {
    const done = complete();
    done.completedAt = iso('2026-08-01'); done.chapters[0]!.doneAt = iso('2026-07-01');
    const f = await fixture({ quests: [done] });
    const entries = (await f.chronicle()).entries;
    expect(entries.find(e => e.kind === 'quest-completed')!.at).toBe(iso('2026-08-01'));
    expect(entries.find(e => e.kind === 'chapter-completed')!.at).toBe(iso('2026-07-01'));
    expect(entries.filter(e => e.kind === 'title' || e.kind === 'rank').every(e => e.at === iso())).toBe(true);
    expect([...f.data.keys()].filter(key => key.startsWith('chronicle:'))).toHaveLength(3);
    const before = structuredClone(f.data);
    await fixture({ quests: [done], data: f.data });
    expect(f.data).toEqual(before);
  });
});

describe('§16.4 titles, gifts and wear', () => {
  it.each([3, 4])('uses shifted completion periods at hour %i for on-time titles, including backfill', async hour => {
    const list = Array.from({ length: 4 }, (_, i) => complete(quest({ id: String(i), kind: 'side',
      chapters: [], deadline: '2026-10-04' })));
    for (const item of list) item.completedAt = iso('2026-10-04');
    const f = await fixture({ quests: list, now: local('2026-10-05', hour) });
    expect((await f.sheet()).titles.find(t => t.id === 'on-time')!.earnedAt).toBeUndefined();
    const fifth = complete(quest({ id: 'fifth', kind: 'side', chapters: [], deadline: '2026-10-04' }));
    fifth.completedAt = iso('2026-10-05', hour);
    await f.emit('quest/completed', { quest: fifth });
    expect(Boolean((await f.sheet()).titles.find(t => t.id === 'on-time')!.earnedAt)).toBe(hour < 4);
    const backfill = await fixture({ quests: [...list, fifth], now: local('2026-10-05', hour) });
    expect(await backfill.sheet()).toEqual(await f.sheet());
  });

  it('accepts the first main gift only, retains it through rewrite/restart and works without scribe', async () => {
    const f = await fixture({ quests: [complete(), complete(quest({ id: 'side', kind: 'side' }))] });
    const epilogue = { questId: 'q', text: '写到卷终。', writtenAt: iso() };
    await f.gift(epilogue);
    await f.gift({ ...epilogue, questId: 'side', title: '不应获得' });
    await f.gift({ ...epilogue, questId: 'absent', title: '不应获得' });
    expect((await f.sheet()).titles.filter(t => t.questId)).toEqual([]);
    await f.gift({ ...epilogue, title: '三卷读罢' });
    await f.gift({ ...epilogue, title: '再次题赠' });
    expect((await f.sheet()).titles.filter(t => t.questId)).toEqual([
      { id: 'gift:q', name: '三卷读罢', hint: '为「Learn」题', questId: 'q', earnedAt: iso() },
    ]);
    expect((await f.chronicle()).entries.filter(e => e.kind === 'title' && e.titleId === 'gift:q')).toHaveLength(1);
    expect((await fixture({ data: f.data, quests: [] }).then(f => f.sheet())).titles.filter(t => t.questId)).toHaveLength(1);
  });

  it('wears only earned titles, supports null, persists and emits the complete sheet', async () => {
    const f = await fixture({ quests: [complete()] });
    for (const titleId of ['absent', 'three-volumes']) await expect(f.request('character/wear', { titleId }))
      .rejects.toMatchObject({ code: 'character/not-found' });
    const worn = await f.request('character/wear', { titleId: 'first-volume' });
    expect(worn.worn).toBe('first-volume');
    expect(f.messages.filter(m => m.type === 'character/changed').at(-1)!.payload).toEqual({ sheet: worn });
    expect((await fixture({ data: f.data, quests: [complete()] }).then(f => f.sheet())).worn).toBe('first-volume');
    expect((await f.request('character/wear', { titleId: null })).worn).toBeNull();
  });
});

describe('§16.5–16.8 notifications, chronicle and failures', () => {
  it.each([false, true])('emits all milestones, caps detailed toasts at three and survives notify failure=%s', async notifyFails => {
    const f = await fixture({ notifyFails });
    await f.emit('quest/completed', { quest: complete() });
    const milestones = f.messages.filter(m => m.type === 'character/milestone');
    expect(milestones).toHaveLength(5);
    expect(f.notify).toHaveBeenCalledTimes(4);
    expect(f.notify.mock.calls.at(-1)).toEqual([{ title: '另有 2 项' }, expect.anything()]);
    expect(points(await f.sheet())[0]).toBe(105);
    if (notifyFails) expect(f.log.warn).toHaveBeenCalled();
    await f.emit('quest/completed', { quest: complete() });
    expect(f.notify).toHaveBeenCalledTimes(4);
  });

  it('keeps committed state unchanged on a failed transaction and retries from a later snapshot', async () => {
    const f = await fixture();
    const before = structuredClone(f.data);
    const set = vi.mocked(f.storage.set).getMockImplementation()!;
    vi.mocked(f.storage.set).mockImplementation(async (key, value) => {
      if (key === 'state') throw new Error('disk full');
      await set(key, value);
    });
    await f.emit('quest/completed', { quest: complete() });
    expect(f.data).toEqual(before);
    expect(points(await f.sheet())[0]).toBe(0);
    expect(f.notify).not.toHaveBeenCalled();
    vi.mocked(f.storage.set).mockImplementation(set);
    await f.emit('quest/completed', { quest: complete() });
    expect(points(await f.sheet())[0]).toBe(105);
    expect((await f.chronicle()).entries.filter(e => e.kind === 'quest-completed')).toHaveLength(1);
  });

  it('paginates old quest completions newest first, keeps labels, validates inputs and releases handlers on unload', async () => {
    const list = Array.from({ length: 55 }, (_, i) => {
      const done = complete(quest({ id: String(i), title: `Task ${i}`, kind: 'side', chapters: [] }));
      done.completedAt = new Date(local('2026-07-01') + i * 86_400_000).toISOString();
      return done;
    });
    const f = await fixture({ quests: list });
    const first = await f.chronicle();
    expect(first.entries).toHaveLength(50); expect(first.more).toBe(true);
    const second = await f.request('character/chronicle', { before: first.entries.at(-1)!.at });
    expect(second.more).toBe(false);
    expect(new Set([...first.entries, ...second.entries].map(e => e.id)).size).toBe(first.entries.length + second.entries.length);
    for (const payload of [{ limit: 0 }, { limit: 1.5 }, { before: 'yesterday' }]) {
      await expect(f.request('character/chronicle', payload)).rejects.toMatchObject({ code: 'character/invalid-input' });
    }
    const before = structuredClone(f.data);
    await f.kernel.unload('character');
    await expect(f.sheet()).rejects.toMatchObject({ code: 'no-handler' });
    await f.emit('quest/completed', { quest: complete() }).catch(() => {});
    expect(f.data).toEqual(before);
  });

  it('rejects damaged state at setup without covering it up', async () => {
    const data = new Map<string, Json>([['state', { schemaVersion: 99 }]]);
    const before = structuredClone(data);
    const f = await fixture({ data });
    expect(f.failed).toBeDefined(); expect(data).toEqual(before);
    await expect(f.sheet()).rejects.toMatchObject({ code: 'no-handler' });
  });
});

it('keeps the entire timestamp group on a page so before never skips simultaneous milestones', async () => {
  const f = await fixture({ quests: [complete()] });
  const first = await f.request('character/chronicle', { limit: 1 });
  expect(first.entries.length).toBeGreaterThan(1);
  expect(first.more).toBe(false);
  expect(new Set(first.entries.map(e => e.at))).toEqual(new Set([iso()]));
  expect(await f.request('character/chronicle', { before: first.entries.at(-1)!.at, limit: 1 }))
    .toEqual({ entries: [], more: false });
});

it('does not emit notifications or events after an in-flight commit finishes on unload', async () => {
  const f = await fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const set = vi.mocked(f.storage.set).getMockImplementation()!;
  vi.mocked(f.storage.set).mockImplementation(async (key, value) => {
    if (key === 'state') { entered(); await pending; }
    await set(key, value);
  });
  const work = f.emit('quest/completed', { quest: complete() }).catch(() => {});
  await reached;
  await f.kernel.unload('character');
  const before = f.messages.filter(m => m.source === 'character' && m.kind === 'event').length;
  release(); await work; await Promise.resolve();
  expect(f.messages.filter(m => m.source === 'character' && m.kind === 'event')).toHaveLength(before);
  expect(f.notify).not.toHaveBeenCalled();
});
