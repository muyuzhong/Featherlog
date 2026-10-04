import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '@featherlog/kernel';
import type {
  Clock, Envelope, Json, Note, NotesRequests, PluginStorage, Quest, RequestPayload, ResponseData,
} from '@featherlog/contracts';
import { setup } from './index';

const start = Date.parse('2026-10-04T12:00:00.000Z');
const saved = (note: Note, schemaVersion = 1): Json => ({ schemaVersion, note } as unknown as Json);
const note = (id = 'a', patch: Partial<Note> = {}): Note => ({
  id, text: 'A page', createdAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString(), ...patch,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(options: { data?: Map<string, Json>; noQuest?: boolean; corrupt?: boolean; questIds?: string[] } = {}) {
  let time = start;
  const timers = new Map<() => void, number>();
  const clock: Clock = { now: () => time, setTimeout(callback, ms) {
    timers.set(callback, time + ms); return () => { timers.delete(callback); };
  } };
  const data = options.data ?? new Map<string, Json>();
  const storage: PluginStorage = {
    async get<T extends Json>(key: string) {
      if (options.corrupt) throw Object.assign(new Error('Corrupt JSON'), { code: 'shell/storage-corrupt' });
      return structuredClone(data.get(key)) as T | undefined;
    },
    set: vi.fn(async (key, value) => { data.set(key, structuredClone(value)); }),
    delete: vi.fn(async key => { data.delete(key); }),
    keys: vi.fn(async () => [...data.keys()]),
  };
  vi.spyOn(storage, 'get');
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const kernel = createKernel({ development: true, clock, log, createServices: () => ({ clock, log, storage,
    settings: { get: () => undefined, onChange: () => () => {} },
    secrets: { get: async () => undefined, onChange: () => () => {} } }) });
  const user = kernel.createBus('quest');
  const quests = new Set(options.questIds ?? ['q1', 'q2', '__proto__']);
  const questGet = vi.fn((payload: { id: string }) => {
    if (!quests.has(payload.id)) throw Object.assign(new Error('Quest missing'), { code: 'quest/not-found' });
    const quest: Quest = { id: payload.id, kind: 'side', title: payload.id, status: 'completed', priority: 'none',
      tracked: false, revealed: false, chapters: [], order: 0, createdAt: new Date(start).toISOString(),
      updatedAt: new Date(start).toISOString(), derived: {
        chapterIndex: -1, objectiveIndex: -1, ratio: 1, chapterRatio: 1, streak: 0, dueToday: false, overdue: false,
      } };
    return { quest };
  });
  if (!options.noQuest) user.handle('quest/get', questGet);
  user.handle('quest/delete', (payload, envelope) => {
    quests.delete(payload.id);
    user.emit('quest/deleted', { id: payload.id }, { causedBy: envelope.id });
    return null;
  });
  const messages: Envelope[] = [];
  kernel.observe(message => messages.push(message));
  await kernel.load([{ manifest: { id: 'notes', name: '笔记', version: '0.1.0' }, setup }]);
  const failed = messages.find(message => message.type === 'kernel/plugin-failed');
  const request = <K extends keyof NotesRequests>(type: K, payload: RequestPayload<K>) =>
    user.request(type, payload) as Promise<ResponseData<K>>;
  if (!failed) await request('notes/list', {});
  const create = async (text = 'A page', questId?: string) => (await request('notes/create', {
    input: { text, ...(questId === undefined ? {} : { questId }) },
  })).note;
  const events = () => messages.filter(message => message.kind === 'event' && message.type.startsWith('notes/'));
  return { kernel, user, request, create, messages, events, failed, storage, data, log, questGet, timers,
    setTime(value: number) { time = value; },
    deleteQuest: (id: string) => user.request('quest/delete', { id }),
  };
}

describe('text, association and CRUD', () => {
  it('stores plain text and line breaks, generates unique ids and uses Clock timestamps', async () => {
    const f = await fixture();
    const a = await f.create('  第一行\n  **不是标记** <b>原文</b>\n第二行  ');
    expect(a).toEqual({ id: expect.any(String), text: '第一行\n  **不是标记** <b>原文</b>\n第二行',
      createdAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString() });
    expect(a).not.toHaveProperty('questId');
    expect(f.questGet).not.toHaveBeenCalled();
    f.setTime(start + 1000);
    const b = await f.create('手记', 'q1');
    expect(b.questId).toBe('q1'); expect(b.id).not.toBe(a.id);
    expect(f.questGet.mock.calls.map(([payload]) => payload)).toEqual([{ id: 'q1' }]);
    expect((await f.request('notes/get', { id: a.id })).note).toEqual(a);
    expect(f.events().map(event => event.type)).toEqual(['notes/created', 'notes/created']);
    expect(f.events()[0]).toMatchObject({ origin: 'quest', payload: { note: a },
      causedBy: f.messages.find(message => message.type === 'notes/create')!.id });
  });

  it.each(['', ' ', '\t\r\n', 'x'.repeat(20_001), null, 5, {}])('rejects invalid create/update text (%#)', async value => {
    const f = await fixture();
    const existing = await f.create();
    f.messages.length = 0; vi.mocked(f.storage.set).mockClear();
    for (const [type, payload] of [
      ['notes/create', { input: { text: value } }], ['notes/update', { id: existing.id, text: value }],
    ] as const) {
      await expect(f.request(type, payload as RequestPayload<typeof type>)).rejects.toMatchObject({ code: 'notes/invalid-input' });
    }
    expect(f.events()).toEqual([]); expect(f.storage.set).not.toHaveBeenCalled();
  });

  it('accepts the 20000-character boundary after trimming', async () => {
    const f = await fixture();
    const a = await f.create(` \n${'字'.repeat(20_000)}\t `);
    expect(a.text).toHaveLength(20_000);
    const changed = (await f.request('notes/update', { id: a.id, text: 'a'.repeat(20_000) })).note;
    expect(changed.text).toHaveLength(20_000);
  });

  it.each(['missing', '', ' ', null, 3])('rejects invalid or missing quest associations (%j)', async questId => {
    const f = await fixture();
    await expect(f.request('notes/create', { input: { text: '手记', questId } } as RequestPayload<'notes/create'>))
      .rejects.toMatchObject({ code: 'notes/invalid-input' });
    expect(f.storage.set).not.toHaveBeenCalled(); expect(f.events()).toEqual([]);
  });

  it('allows standalone notes while quests are unavailable and preserves dependency failures', async () => {
    const f = await fixture({ noQuest: true });
    await f.create('随笔');
    await expect(f.create('手记', 'q1')).rejects.toMatchObject({ code: 'handler-error' });
    expect((await f.request('notes/list', {})).notes).toHaveLength(1);
  });

  it('edits text with Clock, never moves a note or changes createdAt, and avoids no-op writes', async () => {
    const f = await fixture();
    const a = await f.create('原文', 'q1');
    vi.mocked(f.storage.set).mockClear(); f.messages.length = 0;
    expect((await f.request('notes/update', { id: a.id, text: ' 原文 ' })).note).toEqual(a);
    expect(f.storage.set).not.toHaveBeenCalled(); expect(f.events()).toEqual([]);
    f.setTime(start + 86_400_000);
    const updated = (await f.request('notes/update', { id: a.id, text: '修改\n保留换行', questId: 'q2' } as RequestPayload<'notes/update'>)).note;
    expect(updated).toEqual({ ...a, text: '修改\n保留换行', updatedAt: new Date(start + 86_400_000).toISOString() });
    expect(f.events()[0]).toMatchObject({ type: 'notes/updated', payload: { note: updated }, origin: 'quest' });
    expect(f.questGet).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'q1'])('deletes one note and reports its original association (%s)', async questId => {
    const f = await fixture();
    const a = await f.create('正文', questId);
    f.messages.length = 0;
    expect(await f.request('notes/delete', { id: a.id })).toBeNull();
    expect(f.events()).toHaveLength(1);
    expect(f.events()[0]).toMatchObject({ type: 'notes/deleted', payload: { id: a.id,
      ...(questId === undefined ? {} : { questId }) }, origin: 'quest' });
    if (questId === undefined) expect(f.events()[0]?.payload).not.toHaveProperty('questId');
    for (const [type, payload] of [
      ['notes/get', { id: a.id }], ['notes/update', { id: a.id, text: '修改' }], ['notes/delete', { id: a.id }],
    ] as const) await expect(f.request(type, payload as RequestPayload<typeof type>)).rejects.toMatchObject({ code: 'notes/not-found' });
  });

  it.each(['notes/list', 'notes/get', 'notes/create', 'notes/update', 'notes/delete', 'notes/counts'] as const)
    ('rejects malformed payloads for %s', async type => {
      const f = await fixture();
      for (const payload of [null, [], 'value']) await expect(f.request(type, payload as unknown as RequestPayload<typeof type>))
        .rejects.toMatchObject({ code: 'notes/invalid-input' });
    });
  it.each(['', ' ', null, 3])('rejects invalid get ids (%j)', async id => {
    const f = await fixture();
    await expect(f.request('notes/get', { id } as RequestPayload<'notes/get'>)).rejects.toMatchObject({ code: 'notes/invalid-input' });
  });
});

describe('listing, cursor and counts', () => {
  it('pages newest first with a strict before cursor, default 50, and accurate more', async () => {
    const f = await fixture();
    const created: Note[] = [];
    for (let i = 0; i < 53; i++) created.push(await f.create(String(i)));
    const page = await f.request('notes/list', {});
    expect(page.notes).toEqual(created.slice(3).reverse()); expect(page.more).toBe(true);
    const rest = await f.request('notes/list', { before: page.notes.at(-1)!.createdAt });
    expect(rest).toEqual({ notes: created.slice(0, 3).reverse(), more: false });
    expect(await f.request('notes/list', { before: created[0]!.createdAt })).toEqual({ notes: [], more: false });
    expect((await f.request('notes/list', { limit: 53 })).more).toBe(false);
    expect(new Set(created.map(note => note.createdAt)).size).toBe(53);
    expect(created[52]?.createdAt).toBe(new Date(start + 52).toISOString());
  });

  it('preserves a unique creation cursor across restart, same Clock tick and clock rollback', async () => {
    const f = await fixture();
    const a = await f.create(); const b = await f.create();
    f.kernel.unload('notes');
    const reopened = await fixture({ data: f.data });
    reopened.setTime(start - 1000);
    const c = await reopened.create();
    expect(Date.parse(c.createdAt)).toBe(Date.parse(b.createdAt) + 1);
    expect((await reopened.request('notes/list', { before: c.createdAt })).notes).toEqual([b, a]);
  });

  it('combines quest/standalone filters, case-insensitive substring search and cursor/limit', async () => {
    const f = await fixture();
    const essay = await f.create('Alpha\n银弹');
    const q1 = await f.create('ALPHA 手记', 'q1');
    const q2 = await f.create('Beta 手记', 'q2');
    expect((await f.request('notes/list', {})).notes).toEqual([q2, q1, essay]);
    expect((await f.request('notes/list', { questId: null })).notes).toEqual([essay]);
    expect((await f.request('notes/list', { questId: 'q1' })).notes).toEqual([q1]);
    expect((await f.request('notes/list', { questId: 'missing' })).notes).toEqual([]);
    expect((await f.request('notes/list', { query: 'aLpHa' })).notes).toEqual([q1, essay]);
    expect((await f.request('notes/list', { query: '银弹', questId: null })).notes).toEqual([essay]);
    expect(await f.request('notes/list', { query: 'alpha', limit: 1, before: q2.createdAt })).toEqual({ notes: [q1], more: true });
    expect((await f.request('notes/list', { query: '' })).notes).toHaveLength(3);
    expect((await f.request('notes/list', { query: '  ' })).notes).toEqual([]);
  });

  it('compares offset timestamps as instants rather than strings', async () => {
    const f = await fixture(); const a = await f.create();
    expect((await f.request('notes/list', { before: '2026-10-04T20:00:00.001+08:00' })).notes).toEqual([a]);
    expect((await f.request('notes/list', { before: '2026-10-04T20:00:00+08:00' })).notes).toEqual([]);
  });

  it.each([
    { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: '50' }, { limit: null },
    { limit: Number.MAX_SAFE_INTEGER + 1 }, { before: 'bad' }, { before: '2026-10-04' },
    { before: '2026-02-30T12:00:00Z' }, { before: '2026-10-04T25:00:00Z' },
    { before: null }, { questId: '' }, { questId: 1 }, { query: null }, { query: 1 },
  ])('rejects invalid list options %j', async payload => {
    const f = await fixture();
    await expect(f.request('notes/list', payload as RequestPayload<'notes/list'>)).rejects.toMatchObject({ code: 'notes/invalid-input' });
  });

  it('counts requested quests including zero, duplicates and prototype-like ids', async () => {
    const f = await fixture();
    await f.create('随笔'); await f.create('第一则', 'q1'); await f.create('第二则', 'q1');
    await f.create('特殊 id', '__proto__');
    expect(await f.request('notes/counts', { questIds: ['q1', 'q2', 'missing', 'q1', '__proto__', 'constructor'] }))
      .toEqual({ counts: { q1: 2, q2: 0, missing: 0, ['__proto__']: 1, constructor: 0 } });
    expect(await f.request('notes/counts', { questIds: [] })).toEqual({ counts: {} });
    expect(f.questGet).toHaveBeenCalledTimes(3);
  });
  it.each([{}, { questIds: null }, { questIds: 'q1' }, { questIds: [''] }, { questIds: [1] }])
    ('rejects invalid counts %j', async payload => {
      const f = await fixture();
      await expect(f.request('notes/counts', payload as RequestPayload<'notes/counts'>)).rejects.toMatchObject({ code: 'notes/invalid-input' });
    });
});

describe('deletion, persistence and concurrent writes', () => {
  it('turns all deleted-quest notes into essays with unchanged bodies and one event per note', async () => {
    const f = await fixture();
    const a = await f.create('第一则\n正文', 'q1'); const b = await f.create('第二则', 'q1');
    const other = await f.create('另一任务', 'q2'); const essay = await f.create('随笔');
    f.setTime(start + 1000); f.messages.length = 0;
    await f.deleteQuest('q1');
    const list = await f.request('notes/list', { questId: null });
    expect(list.notes.map(note => note.text)).toEqual([essay.text, b.text, a.text]);
    expect((await f.request('notes/get', { id: other.id })).note).toEqual(other);
    expect(f.events()).toHaveLength(2);
    const cause = f.messages.find(message => message.type === 'quest/deleted')!.id;
    for (const event of f.events()) {
      expect(event).toMatchObject({ type: 'notes/updated', causedBy: cause });
      const note = (event.payload as { note: Note }).note;
      expect(note).not.toHaveProperty('questId');
      expect(note.updatedAt).toBe(new Date(start + 1000).toISOString());
      expect(note.createdAt).toBe(note.id === a.id ? a.createdAt : b.createdAt);
    }
    expect((await f.request('notes/counts', { questIds: ['q1', 'q2'] })).counts).toEqual({ q1: 0, q2: 1 });
  });

  it('repairs missed quest deletions after kernel/ready, including after a partial failed detach', async () => {
    const f = await fixture();
    await f.create('第一则', 'q1'); await f.create('第二则', 'q1'); await f.create('第三则', 'q1');
    const set = vi.mocked(f.storage.set).getMockImplementation()!;
    let count = 0;
    vi.mocked(f.storage.set).mockImplementation(async (key, value) => {
      if (++count === 2) throw new Error('Disk full');
      await set(key, value);
    });
    await f.deleteQuest('q1'); await f.request('notes/list', {});
    expect(f.events().filter(event => event.type === 'notes/updated')).toHaveLength(1);
    f.kernel.unload('notes');
    const reopened = await fixture({ data: f.data, questIds: ['q2'] });
    expect((await reopened.request('notes/list', { questId: null })).notes).toHaveLength(3);
    expect(reopened.events()).toHaveLength(2);
  });

  it('repairs genuinely orphaned notes on startup, but leaves them intact if quests cannot be read', async () => {
    const orphan = note('orphan', { questId: 'missing' });
    const data = new Map([['note:orphan', saved(orphan)]]);
    const absent = await fixture({ data: structuredClone(data), noQuest: true });
    expect((await absent.request('notes/get', { id: orphan.id })).note).toEqual(orphan);
    expect(absent.storage.set).not.toHaveBeenCalled();
    expect(absent.log.error).toHaveBeenCalled();
    const f = await fixture({ data });
    expect((await f.request('notes/get', { id: orphan.id })).note).not.toHaveProperty('questId');
    expect(f.events()).toHaveLength(1);
    expect(f.messages.findIndex(message => message.type === 'kernel/ready'))
      .toBeLessThan(f.messages.findIndex(message => message.type === 'quest/get'));
  });

  it('serializes concurrent creation, edits, deletion and detachment without losing other notes', async () => {
    const f = await fixture();
    const notes = await Promise.all(Array.from({ length: 20 }, (_, index) => f.create(String(index), 'q1')));
    expect(new Set(notes.map(note => note.id)).size).toBe(20);
    const id = notes[0]!.id;
    await Promise.all([
      f.request('notes/update', { id, text: '第一次改' }), f.request('notes/update', { id, text: '第二次改' }),
      f.request('notes/delete', { id: notes[1]!.id }), f.deleteQuest('q1'),
    ]);
    const result = (await f.request('notes/list', { questId: null })).notes;
    expect(result).toHaveLength(19);
    expect(result.find(note => note.id === id)?.text).toBe('第二次改');
    expect(result.every(note => note.questId === undefined)).toBe(true);
    await expect(f.create('已删除任务', 'q1')).rejects.toMatchObject({ code: 'notes/invalid-input' });
  });

  it('handles a quest deletion while a new associated note is awaiting storage', async () => {
    const f = await fixture();
    const entered = deferred(); const release = deferred();
    const set = vi.mocked(f.storage.set).getMockImplementation()!;
    vi.mocked(f.storage.set).mockImplementationOnce(async (key, value) => {
      entered.resolve(); await release.promise; await set(key, value);
    });
    const creating = f.create('正在写', 'q1');
    await entered.promise;
    await f.deleteQuest('q1');
    release.resolve(); const a = await creating;
    expect((await f.request('notes/get', { id: a.id })).note).not.toHaveProperty('questId');
  });

  it('reads/writes only the affected record for get/update/delete, and reopens saved data', async () => {
    const f = await fixture();
    const a = await f.create(); const b = await f.create('其他');
    vi.mocked(f.storage.get).mockClear(); vi.mocked(f.storage.set).mockClear(); vi.mocked(f.storage.keys).mockClear();
    await f.request('notes/get', { id: a.id });
    const changed = (await f.request('notes/update', { id: a.id, text: '修改' })).note;
    expect(vi.mocked(f.storage.get).mock.calls.map(([key]) => key)).toEqual([`note:${a.id}`, `note:${a.id}`]);
    expect(f.storage.set).toHaveBeenCalledExactlyOnceWith(`note:${a.id}`, saved(changed));
    expect(f.storage.keys).not.toHaveBeenCalled();
    expect(f.data.get(`note:${b.id}`)).toEqual(saved(b));
    f.kernel.unload('notes');
    const reopened = await fixture({ data: f.data });
    expect((await reopened.request('notes/get', { id: a.id })).note).toEqual(changed);
    await reopened.request('notes/delete', { id: a.id });
    expect(reopened.storage.delete).toHaveBeenCalledExactlyOnceWith(`note:${a.id}`);
    expect(reopened.data.get(`note:${b.id}`)).toEqual(saved(b));
  });

  it('publishes only after atomic storage completes and leaves old data intact on write/delete failure', async () => {
    const f = await fixture(); const a = await f.create('原文');
    const entered = deferred(); const release = deferred();
    const set = vi.mocked(f.storage.set).getMockImplementation()!;
    f.messages.length = 0;
    vi.mocked(f.storage.set).mockImplementationOnce(async (key, value) => {
      entered.resolve(); await release.promise; await set(key, value);
    });
    const updating = f.request('notes/update', { id: a.id, text: '修改' });
    await entered.promise;
    expect(f.data.get(`note:${a.id}`)).toEqual(saved(a)); expect(f.events()).toEqual([]);
    release.resolve(); const updated = (await updating).note;
    expect(f.data.get(`note:${a.id}`)).toEqual(saved(updated)); expect(f.events()).toHaveLength(1);
    f.messages.length = 0;
    vi.mocked(f.storage.set).mockRejectedValueOnce(new Error('Disk full'));
    await expect(f.request('notes/update', { id: a.id, text: '失败修改' })).rejects.toMatchObject({ code: 'handler-error' });
    vi.mocked(f.storage.delete).mockRejectedValueOnce(new Error('Locked'));
    await expect(f.request('notes/delete', { id: a.id })).rejects.toMatchObject({ code: 'handler-error' });
    expect(f.data.get(`note:${a.id}`)).toEqual(saved(updated)); expect(f.events()).toEqual([]);
    expect((await f.request('notes/get', { id: a.id })).note).toEqual(updated);
    await f.request('notes/update', { id: a.id, text: '重试成功' });
  });

  it('does not consume a cursor or publish on failed create', async () => {
    const f = await fixture();
    vi.mocked(f.storage.set).mockRejectedValueOnce(new Error('Disk full'));
    await expect(f.create()).rejects.toMatchObject({ code: 'handler-error' });
    expect(f.events()).toEqual([]); expect(f.data.size).toBe(0);
    expect((await f.create()).createdAt).toBe(new Date(start).toISOString());
  });

  it.each([
    null, { schemaVersion: 2, note: note() }, { schemaVersion: 1, note: { ...note(), id: 'wrong' } },
    { schemaVersion: 1, note: { ...note(), text: ' ' } },
    { schemaVersion: 1, note: { ...note(), text: 'x'.repeat(20_001) } },
    { schemaVersion: 1, note: { ...note(), createdAt: 'invalid' } },
    { schemaVersion: 1, note: { ...note(), updatedAt: '2026-02-30T12:00:00Z' } },
    { schemaVersion: 1, note: { ...note(), questId: null } },
  ])('refuses corrupt records on startup without any writes (%#)', async value => {
    const data = new Map<string, Json>([['note:valid', saved(note('valid'))], ['note:a', value as Json]]);
    const original = structuredClone(data);
    const f = await fixture({ data });
    expect(f.failed).toMatchObject({ payload: { error: { code: 'notes/invalid-input' } } });
    expect(f.storage.set).not.toHaveBeenCalled(); expect(f.storage.delete).not.toHaveBeenCalled();
    expect(data).toEqual(original);
    await expect(f.request('notes/list', {})).rejects.toMatchObject({ code: 'no-handler' });
  });

  it('never overwrites runtime corruption or storage parse failures, and leaves unrelated keys intact', async () => {
    const f = await fixture(); const a = await f.create();
    const broken: Json = { schemaVersion: 1, note: { id: a.id, text: ' ' } };
    f.data.set(`note:${a.id}`, broken);
    vi.mocked(f.storage.set).mockClear(); vi.mocked(f.storage.delete).mockClear();
    await expect(f.request('notes/update', { id: a.id, text: '不能覆盖' })).rejects.toMatchObject({ code: 'notes/invalid-input' });
    await expect(f.request('notes/delete', { id: a.id })).rejects.toMatchObject({ code: 'notes/invalid-input' });
    expect(f.data.get(`note:${a.id}`)).toEqual(broken);
    expect(f.storage.set).not.toHaveBeenCalled(); expect(f.storage.delete).not.toHaveBeenCalled();
    const corrupt = await fixture({ data: new Map([['note:a', saved(note())]]), corrupt: true });
    expect(corrupt.failed).toMatchObject({ payload: { error: { code: 'shell/storage-corrupt' } } });
    expect(corrupt.storage.set).not.toHaveBeenCalled(); expect(corrupt.storage.delete).not.toHaveBeenCalled();
    const unrelated = await fixture({ data: new Map([['other', { retained: true }]]) });
    expect(unrelated.data.get('other')).toEqual({ retained: true });
    expect(unrelated.storage.delete).not.toHaveBeenCalled();
  });

  it('cleans handlers/listeners on unload and suppresses late events and queued writes', async () => {
    const f = await fixture(); const a = await f.create();
    const entered = deferred(); const release = deferred();
    const set = vi.mocked(f.storage.set).getMockImplementation()!;
    vi.mocked(f.storage.set).mockImplementationOnce(async (key, value) => {
      entered.resolve(); await release.promise; await set(key, value);
    });
    const first = expect(f.request('notes/update', { id: a.id, text: '在途' })).rejects.toMatchObject({ code: 'disposed' });
    await entered.promise;
    const second = expect(f.create('排队')).rejects.toMatchObject({ code: 'disposed' });
    f.messages.length = 0;
    f.kernel.unload('notes'); release.resolve(); await first; await second;
    await Promise.resolve(); await Promise.resolve();
    expect(f.events()).toEqual([]);
    expect(f.data.size).toBe(1);
    await f.deleteQuest('q1');
    await expect(f.request('notes/list', {})).rejects.toMatchObject({ code: 'no-handler' });
    expect(f.events()).toEqual([]);
  });
});
