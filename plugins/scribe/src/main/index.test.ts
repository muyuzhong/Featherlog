import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '@featherlog/kernel';
import type {
  Clock, Envelope, EventPayload, Json, PluginSettings, PluginStorage, Quest, QuestEvents,
  RequestPayload, ResponseData, ScribeRequests,
} from '@featherlog/contracts';
import { setup } from './index';
import type { ModelClient, ModelReply } from './model';
import { failure } from './model';
import { PERSONA } from './writing';

const local = (day = '2026-10-03', hour = 12, minute = 0) => new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).getTime();
function quest(patch: Partial<Quest> = {}): Quest {
  return { id: 'q1', kind: 'main', title: '学习', status: 'active', priority: 'none', tracked: true,
    revealed: false, chapters: [{ id: 'ch1', title: '开卷', objectives: [{ id: 'o1', text: '读第一节' }, { id: 'o2', text: '写摘要' }] }],
    order: 0, createdAt: new Date(local()).toISOString(), updatedAt: new Date(local()).toISOString(),
    derived: { chapterIndex: 0, objectiveIndex: 0, ratio: 0, chapterRatio: 0, streak: 0, dueToday: false, overdue: false }, ...patch };
}
async function fixture(options: {
  time?: number; enabled?: boolean; consent?: boolean; settings?: Record<string, Json>;
  key?: string | null; data?: Map<string, Json>; quests?: Quest[]; noQuest?: boolean; defaultFilter?: boolean;
  client?: ModelClient;
} = {}) {
  let time = options.time ?? local();
  let key = options.key === null ? undefined : options.key ?? 'private-key';
  let list = options.quests ?? [quest({ createdAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString() })];
  let hour = 4;
  const timers = new Map<() => void, number>();
  const clock: Clock = { now: () => time, setTimeout(callback, ms) {
    timers.set(callback, time + ms); return () => { timers.delete(callback); };
  } };
  const values: Record<string, Json> = { enabled: options.enabled ?? true, protocol: 'openai',
    baseUrl: 'https://model.example/v1', model: 'model-a', talkativeness: 'normal', recapTime: 22, ...options.settings };
  const settingListeners = new Set<(key: string, value: Json | undefined) => void>();
  const secretListeners = new Set<(key: string) => void>();
  const settings: PluginSettings = { get<T extends Json>(name: string) { return values[name] as T | undefined; },
    onChange(listener) { settingListeners.add(listener); return () => { settingListeners.delete(listener); }; } };
  const data = options.data ?? new Map<string, Json>();
  const storage: PluginStorage = {
    async get<T extends Json>(name: string) { return structuredClone(data.get(name)) as T | undefined; },
    async set(name, value) { data.set(name, structuredClone(value)); },
    async keys() { return [...data.keys()]; }, async delete(name) { data.delete(name); },
  };
  const model = vi.fn<ModelClient>(options.client ?? (async () => ({ text: '此步已过。', usage: { inputTokens: 10, outputTokens: 4 } })));
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const kernel = createKernel({ clock, log, development: true, createServices: () => ({ clock, log, storage, settings,
    secrets: { get: async () => key, onChange(listener) { secretListeners.add(listener); return () => { secretListeners.delete(listener); }; } } }) });
  const user = kernel.createBus('quest');
  const shell = kernel.createBus('shell');
  const messages: Envelope[] = [];
  kernel.observe(message => messages.push(message));
  if (!options.noQuest) {
    user.handle('quest/list', () => ({ quests: list }));
    user.handle('quest/get', payload => {
      const found = list.find(item => item.id === payload.id);
      if (!found) throw Object.assign(new Error('missing'), { code: 'quest/not-found' });
      return { quest: found };
    });
    user.handle('quest/period', () => {
      const date = new Date(time - hour * 3_600_000);
      return { periodKey: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, dayStartHour: hour };
    });
  }
  await kernel.load([{ manifest: { id: 'scribe', name: '翎', version: '0.1.0' }, setup: ctx => setup(ctx, {
    client: model, ...(!options.defaultFilter ? { isLocalAction: envelope => envelope.causedBy === 'user' } : {}),
  }) }]);
  const request = <K extends keyof ScribeRequests>(type: K, payload: RequestPayload<K>) =>
    user.request(type, payload, { timeoutMs: 65_000 }) as Promise<ResponseData<K>>;
  const drain = async () => { for (let i = 0; i < 15; i++) await request('scribe/state', {}); };
  const failed = messages.find(message => message.type === 'kernel/plugin-failed');
  if (!failed) {
    if (options.consent !== false) await request('scribe/consent', { granted: true });
    await drain();
  }
  const emit = <K extends keyof QuestEvents>(type: K, payload: QuestEvents[K], actor = 'user') => {
    if ('quest' in payload) list = list.map(item => item.id === payload.quest.id ? payload.quest : item);
    user.emit(type, payload as EventPayload<K>, { causedBy: actor });
  };
  return { kernel, request, model, log, timers, messages, data, storage, failed, drain, emit,
    lines: async () => (await request('scribe/lines', {})).lines,
    setQuests(value: Quest[]) { list = value; },
    setHour(value: number) { hour = value; },
    setTime(value: number, fire = true) {
      time = value;
      if (fire) for (const [callback, deadline] of [...timers]) if (deadline <= time && timers.delete(callback)) callback();
    },
    change(name: string, value: Json | undefined) {
      if (value === undefined) delete values[name]; else values[name] = value;
      for (const listener of settingListeners) listener(name, value);
    },
    secret(value: string | undefined) { key = value; for (const listener of secretListeners) listener('apiKey'); },
    open(actor = 'user', view: 'panel' | 'collapsed' = 'panel') { shell.emit('shell/view-changed', { view }, { causedBy: actor }); },
  };
}
const draftReply = (input: unknown = { kind: 'side', title: '整理桌面' }): ModelReply => ({ text: JSON.stringify({ input, note: '由你落笔。' }) });

describe('privacy, configuration and requests', () => {
  it('exposes safe state, does not send secrets through the bus or local journal', async () => {
    const f = await fixture();
    expect(await f.request('scribe/state', {})).toMatchObject({ enabled: true, consented: true, configured: true,
      endpoint: 'https://model.example/v1', usage: { month: '2026-10', calls: 0 } });
    expect(JSON.stringify(f.messages)).not.toContain('private-key'); expect(JSON.stringify([...f.data])).not.toContain('private-key');
  });
  it('never calls the model without consent and uses builtin reactions', async () => {
    const f = await fixture({ consent: false });
    await expect(f.request('scribe/draft-quest', { text: '整理' })).rejects.toMatchObject({ code: 'scribe/no-consent' });
    await expect(f.request('scribe/split-objective', { questId: 'q1', objectiveId: 'o1' })).rejects.toMatchObject({ code: 'scribe/no-consent' });
    await expect(f.request('scribe/recap', { write: true })).rejects.toMatchObject({ code: 'scribe/no-consent' });
    expect(await f.request('scribe/test', {})).toMatchObject({ ok: false, code: 'scribe/no-consent' });
    f.emit('quest/objective-completed', { quest: quest(), chapterId: 'ch1', objectiveId: 'o1' }); await f.drain();
    expect(await f.lines()).toEqual([expect.objectContaining({ origin: 'builtin', topic: 'objective' })]);
    expect(f.model).not.toHaveBeenCalled();
  });
  it.each<Record<string, Json>>([{ protocol: 'unsupported' }, { model: '' }, { protocol: null }])('rejects missing configuration %j', async settings => {
    const f = await fixture({ settings });
    expect(await f.request('scribe/state', {})).toMatchObject({ configured: false });
    await expect(f.request('scribe/draft-quest', { text: '写作' })).rejects.toMatchObject({ code: 'scribe/not-configured' });
    expect(f.model).not.toHaveBeenCalled();
  });
  it('requires remote keys, permits keyless local models, rejects insecure addresses', async () => {
    const remote = await fixture({ key: null });
    expect(await remote.request('scribe/test', {})).toMatchObject({ code: 'scribe/not-configured' });
    const localModel = await fixture({ key: null, settings: { baseUrl: 'http://localhost:11434/v1' } });
    expect(await localModel.request('scribe/test', {})).toMatchObject({ ok: true });
    const insecure = await fixture({ consent: false, settings: { baseUrl: 'http://remote.example/v1' } });
    expect(await insecure.request('scribe/state', {})).toMatchObject({ configured: false, consented: false });
    await expect(insecure.request('scribe/consent', { granted: true })).rejects.toMatchObject({ code: 'scribe/not-configured' });
  });
  it('disabling prevents all networking and reactions, even after consent', async () => {
    const f = await fixture({ enabled: false });
    expect(await f.request('scribe/test', {})).toMatchObject({ code: 'scribe/not-configured' });
    f.emit('quest/completed', { quest: quest({ status: 'completed' }) }); f.open(); await f.drain();
    expect(f.model).not.toHaveBeenCalled(); expect(await f.lines()).toEqual([]);
    expect(await f.request('scribe/epilogue', { questId: 'q1' })).toEqual({ epilogue: null });
  });
  it('binds consent to the endpoint and revocation stops networking', async () => {
    const f = await fixture();
    f.change('baseUrl', 'https://other.example/v1'); await f.drain();
    expect(await f.request('scribe/test', {})).toMatchObject({ code: 'scribe/no-consent' });
    await f.request('scribe/consent', { granted: true });
    expect(await f.request('scribe/test', {})).toMatchObject({ ok: true });
    await f.request('scribe/consent', { granted: false });
    expect(await f.request('scribe/test', {})).toMatchObject({ code: 'scribe/no-consent' });
  });
  it('returns missing local records without networking; filters and validates limits', async () => {
    const f = await fixture({ consent: false });
    expect(await f.request('scribe/recap', {})).toEqual({ recap: null });
    expect(await f.request('scribe/recaps', {})).toEqual({ recaps: [] });
    expect(await f.request('scribe/epilogue', { questId: 'absent' })).toEqual({ epilogue: null });
    await expect(f.request('scribe/lines', { limit: 0 })).rejects.toMatchObject({ code: 'scribe/invalid-input' });
    await expect(f.request('scribe/recaps', { limit: 101 })).rejects.toMatchObject({ code: 'scribe/invalid-input' });
    await expect(f.request('scribe/epilogue', { questId: '' })).rejects.toMatchObject({ code: 'scribe/invalid-input' });
  });
});

describe('authentication, cooldowns, cancellation and monthly usage', () => {
  it.each([401, 403])('pauses on HTTP %i until model or key changes', async () => {
    const f = await fixture();
    f.model.mockRejectedValueOnce(failure('scribe/auth-failed', 'private server body'));
    expect(await f.request('scribe/test', {})).toMatchObject({ ok: false, code: 'scribe/auth-failed' });
    expect(await f.request('scribe/state', {})).toMatchObject({ paused: { reason: 'auth' } });
    expect(f.messages.some(message => message.type === 'scribe/state-changed' && JSON.stringify(message.payload).includes('paused'))).toBe(true);
    expect(await f.request('scribe/test', {})).toMatchObject({ code: 'scribe/auth-failed' });
    expect(f.model).toHaveBeenCalledTimes(1);
    f.change('talkativeness', 'chatty');
    expect(await f.request('scribe/test', {})).toMatchObject({ code: 'scribe/auth-failed' });
    f.secret('new-key'); await f.drain();
    expect(await f.request('scribe/test', {})).toMatchObject({ ok: true });
    f.model.mockRejectedValueOnce(failure('scribe/auth-failed', 'auth'));
    await f.request('scribe/test', {});
    f.change('model', 'model-b'); await f.drain();
    expect(await f.request('scribe/test', {})).toMatchObject({ ok: true, model: 'model-b' });
    expect(JSON.stringify(f.messages)).not.toContain('private server body');
  });
  it('falls back during Retry-After and exponential network cooldowns', async () => {
    const f = await fixture();
    f.model.mockRejectedValueOnce(Object.assign(failure('scribe/unavailable', 'limited'), { retryAfterMs: 120_000 }));
    f.emit('quest/objective-completed', { quest: quest(), chapterId: 'ch1', objectiveId: 'o1' }); await f.drain();
    expect((await f.lines())[0]).toMatchObject({ origin: 'builtin' });
    expect(await f.request('scribe/test', {})).toMatchObject({ code: 'scribe/unavailable' });
    expect(f.model).toHaveBeenCalledTimes(1);
    f.setTime(local() + 119_999); expect(await f.request('scribe/test', {})).toMatchObject({ code: 'scribe/unavailable' });
    f.setTime(local() + 120_000); f.model.mockRejectedValueOnce(new Error('network contains key'));
    expect(await f.request('scribe/test', {})).toMatchObject({ code: 'scribe/unavailable' });
    f.setTime(local() + 179_999); expect(await f.request('scribe/test', {})).toMatchObject({ code: 'scribe/unavailable' });
    f.setTime(local() + 180_000); expect(await f.request('scribe/test', {})).toMatchObject({ ok: true });
  });
  it('does not back off permanent request errors', async () => {
    const f = await fixture();
    f.model.mockRejectedValueOnce(Object.assign(failure('scribe/unavailable', 'bad request'), { retryable: false }));
    expect(await f.request('scribe/test', {})).toMatchObject({ ok: false });
    expect(await f.request('scribe/test', {})).toMatchObject({ ok: true });
  });
  it('uses Clock for the 30-second deadline and aborts even an uncooperative client', async () => {
    const f = await fixture();
    f.model.mockImplementationOnce(() => new Promise<ModelReply>(() => {}));
    const pending = f.request('scribe/test', {});
    await vi.waitFor(() => expect(f.model).toHaveBeenCalledOnce());
    const signal = f.model.mock.calls[0]![0].signal;
    f.setTime(local() + 29_999); expect(signal.aborted).toBe(false);
    f.setTime(local() + 30_000);
    expect(await pending).toMatchObject({ ok: false, code: 'scribe/unavailable' }); expect(signal.aborted).toBe(true);
    expect((await f.request('scribe/state', {})).usage).toMatchObject({ calls: 1, unreported: 1 });
  });
  it.each(['disable', 'revoke', 'change', 'unload'] as const)('cancels in-flight calls on %s and publishes no stale line', async action => {
    const f = await fixture();
    let resolve: ((value: ModelReply) => void) | undefined;
    f.model.mockImplementationOnce(() => new Promise<ModelReply>(done => { resolve = done; }));
    f.emit('quest/objective-completed', { quest: quest(), chapterId: 'ch1', objectiveId: 'o1' });
    await vi.waitFor(() => expect(f.model).toHaveBeenCalledOnce());
    if (action === 'disable') f.change('enabled', false);
    if (action === 'revoke') await f.request('scribe/consent', { granted: false });
    if (action === 'change') f.change('model', 'new');
    if (action === 'unload') f.kernel.unload('scribe');
    resolve!({ text: '旧回复。' });
    if (action !== 'unload') { await f.drain(); expect(await f.lines()).toEqual([]); }
    else { await Promise.resolve(); expect(f.messages.filter(message => message.type === 'scribe/said')).toEqual([]); }
    expect(f.model.mock.calls[0]![0].signal.aborted).toBe(true);
  });
  it('counts reported, unreported and retry calls in the starting calendar month', async () => {
    const f = await fixture({ time: local('2026-10-31', 22) });
    await f.request('scribe/test', {});
    f.model.mockResolvedValueOnce({ text: '好' }); await f.request('scribe/test', {});
    expect((await f.request('scribe/state', {})).usage).toEqual({ month: '2026-10', calls: 2, inputTokens: 10, outputTokens: 4, unreported: 1 });
    let resolve: ((reply: ModelReply) => void) | undefined;
    f.model.mockImplementationOnce(() => new Promise<ModelReply>(done => { resolve = done; }));
    const pending = f.request('scribe/test', {});
    await vi.waitFor(() => expect(f.model).toHaveBeenCalledTimes(3));
    f.setTime(local('2026-11-01', 0), false); resolve!({ text: '好', usage: { inputTokens: 2, outputTokens: 1 } }); await pending;
    expect((await f.request('scribe/state', {})).usage).toMatchObject({ month: '2026-11', calls: 0 });
    const stored = f.data.get('state') as { usage: Record<string, { calls: number }> };
    expect(stored.usage['2026-10']!.calls).toBe(3);
  });
});

describe('drafting and splitting never write quests', () => {
  it('provides fixed prefix, JSON schema and example, and validates a successful draft', async () => {
    const f = await fixture(); f.model.mockResolvedValueOnce(draftReply());
    expect(await f.request('scribe/draft-quest', { text: '整理' })).toEqual({ input: { kind: 'side', title: '整理桌面' }, note: '由你落笔。' });
    const input = f.model.mock.calls[0]![0];
    expect(input.prefix).toBe(PERSONA); expect(input.messages[0]!.content).toContain('示例');
    expect(input.messages[0]!.content).toContain('2026-10-03');
    expect(f.messages.filter(message => message.kind === 'request' && /quest\/(create|update|set-chapters)/.test(message.type))).toEqual([]);
  });
  it.each(['not JSON', JSON.stringify({ input: { kind: 'main', title: '缺少章节' } }),
    JSON.stringify({ input: { kind: 'side', title: 'x'.repeat(201) } })])('retries malformed/invalid drafts once: %s', async bad => {
    const f = await fixture(); f.model.mockResolvedValueOnce({ text: bad }).mockResolvedValueOnce(draftReply());
    expect(await f.request('scribe/draft-quest', { text: '整理' })).toMatchObject({ input: { kind: 'side' } });
    expect(f.model).toHaveBeenCalledTimes(2);
    expect(f.model.mock.calls[1]![0].messages).toEqual([expect.objectContaining({ role: 'user' }),
      { role: 'assistant', content: bad }, expect.objectContaining({ role: 'user', content: expect.stringContaining('校验失败') })]);
    expect((await f.request('scribe/state', {})).usage).toMatchObject({ calls: 2, unreported: 2 });
  });
  it('reports unusable-reply after two failed replies and propagates model errors without retrying JSON', async () => {
    const f = await fixture(); f.model.mockResolvedValue({ text: '{}' });
    await expect(f.request('scribe/draft-quest', { text: '整理' })).rejects.toMatchObject({ code: 'scribe/unusable-reply' });
    expect(f.model).toHaveBeenCalledTimes(2);
    f.model.mockRejectedValueOnce(failure('scribe/auth-failed', 'auth'));
    await expect(f.request('scribe/draft-quest', { text: '整理' })).rejects.toMatchObject({ code: 'scribe/auth-failed' });
    expect(f.model).toHaveBeenCalledTimes(3);
  });
  it('returns only 2–4 new steps, drops IDs and preserves saved completed objectives untouched', async () => {
    const original = quest({ chapters: [{ id: 'ch1', title: '开卷', objectives: [
      { id: 'done', text: '已做', doneAt: new Date(local()).toISOString() }, { id: 'o1', text: '当前' },
    ] }], derived: { ...quest().derived, objectiveIndex: 1 } });
    const f = await fixture({ quests: [original] });
    f.model.mockResolvedValueOnce({ text: JSON.stringify({ objectives: [{ id: 'done', text: '小步一' }, { text: '小步二', count: { target: 2 } }] }) });
    expect(await f.request('scribe/split-objective', { questId: 'q1', objectiveId: 'o1' })).toEqual({
      objectives: [{ text: '小步一' }, { text: '小步二', count: { target: 2 } }],
    });
    expect(original.chapters[0]!.objectives[0]!.id).toBe('done');
    expect(original.chapters[0]!.objectives).toHaveLength(2);
  });
  it('retries invalid splits once and rejects non-current, missing and daily objectives', async () => {
    const f = await fixture();
    f.model.mockResolvedValueOnce({ text: JSON.stringify({ objectives: [{ text: 'only' }] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ objectives: [{ text: '一' }, { text: '二' }] }) });
    expect((await f.request('scribe/split-objective', { questId: 'q1', objectiveId: 'o1' })).objectives).toHaveLength(2);
    await expect(f.request('scribe/split-objective', { questId: 'q1', objectiveId: 'o2' })).rejects.toMatchObject({ code: 'scribe/invalid-input' });
    await expect(f.request('scribe/split-objective', { questId: 'none', objectiveId: 'o1' })).rejects.toMatchObject({ code: 'scribe/invalid-input' });
    f.setQuests([quest({ kind: 'daily', chapters: [] })]);
    await expect(f.request('scribe/split-objective', { questId: 'q1', objectiveId: 'o1' })).rejects.toMatchObject({ code: 'scribe/invalid-input' });
  });
  it('rejects invalid user input and unavailable quest readers', async () => {
    const f = await fixture();
    for (const value of ['', ' ', 'x'.repeat(2001)]) await expect(f.request('scribe/draft-quest', { text: value })).rejects.toMatchObject({ code: 'scribe/invalid-input' });
    await expect(f.request('scribe/consent', { granted: 1 } as unknown as { granted: boolean })).rejects.toMatchObject({ code: 'scribe/invalid-input' });
    const absent = await fixture({ noQuest: true });
    await expect(absent.request('scribe/board', {})).rejects.toMatchObject({ code: 'scribe/unavailable' });
  });
});

describe('event provenance, talkativeness and night hours', () => {
  it('ignores self, external, unattributed events and defaults to no reactions without a host filter', async () => {
    const f = await fixture();
    for (const actor of ['scribe', 'external', '']) f.emit('quest/completed', { quest: quest({ status: 'completed' }) }, actor);
    await f.drain(); expect(await f.lines()).toEqual([]); expect(f.model).not.toHaveBeenCalled();
    const noFilter = await fixture({ defaultFilter: true });
    noFilter.emit('quest/completed', { quest: quest({ status: 'completed' }) }); await noFilter.drain();
    expect(noFilter.model).not.toHaveBeenCalled();
  });
  it('normal mode throttles objectives for exactly 3 minutes but always responds to chapters and quests', async () => {
    const f = await fixture({ consent: false });
    const event = { quest: quest(), chapterId: 'ch1', objectiveId: 'o1' };
    f.emit('quest/objective-completed', event); await f.drain();
    f.setTime(local() + 179_999); f.emit('quest/objective-completed', event); await f.drain();
    expect(await f.lines()).toHaveLength(1);
    f.setTime(local() + 180_000); f.emit('quest/objective-completed', event);
    f.emit('quest/chapter-completed', { quest: quest(), chapterId: 'ch1' });
    f.emit('quest/completed', { quest: quest({ status: 'completed' }) }); await f.drain();
    expect((await f.lines()).map(line => line.topic)).toEqual(['quest', 'chapter', 'objective', 'objective']);
  });
  it.each(['quiet', 'chatty'])('implements %s mode', async level => {
    const f = await fixture({ consent: false, settings: { talkativeness: level } });
    f.emit('quest/objective-completed', { quest: quest(), chapterId: 'ch1', objectiveId: 'o1' });
    f.emit('quest/objective-completed', { quest: quest(), chapterId: 'ch1', objectiveId: 'o1' });
    f.emit('quest/objective-reopened', { quest: quest(), chapterId: 'ch1', objectiveId: 'o1' });
    f.emit('quest/chapter-completed', { quest: quest(), chapterId: 'ch1' }); await f.drain();
    expect((await f.lines()).map(line => line.topic)).toEqual(level === 'quiet' ? ['chapter'] : ['chapter', 'reopen', 'objective', 'objective']);
  });
  it.each([23, 0, 6])('is silent at %i:00 but resumes at 7', async hour => {
    const f = await fixture({ time: local('2026-10-03', hour), consent: false });
    f.emit('quest/completed', { quest: quest({ status: 'completed' }) }); await f.drain();
    expect(await f.lines()).toEqual([]); expect(f.model).not.toHaveBeenCalled();
    f.setTime(local('2026-10-04', 7)); await f.drain();
    expect((await f.request('scribe/epilogue', { questId: 'q1' })).epilogue).not.toBeNull();
  });
  it('emits only full validated stream text, keeps bad replies builtin and returns lines newest first', async () => {
    const f = await fixture({ settings: { talkativeness: 'chatty' } });
    f.model.mockResolvedValueOnce({ text: '《学习》这一笔记下了。' })
      .mockResolvedValueOnce({ text: '你又没坚持。' }).mockResolvedValueOnce({ text: '已完成99次。' });
    for (let i = 0; i < 3; i++) { f.emit('quest/objective-completed', { quest: quest(), chapterId: 'ch1', objectiveId: 'o1' }); await f.drain(); }
    const lines = (await f.request('scribe/lines', { questId: 'q1', limit: 2 })).lines;
    expect(lines.map(line => line.origin)).toEqual(['builtin', 'builtin']);
    expect((await f.lines())[2]!.origin).toBe('model');
    expect(f.model.mock.calls.every(([input]) => input.stream && input.prefix === PERSONA)).toBe(true);
    expect(f.messages.filter(message => message.type === 'scribe/said')).toHaveLength(3);
    expect((await f.request('scribe/lines', { questId: 'other' })).lines).toEqual([]);
  });
  it('reports only new streak records and retains peaks after reopen', async () => {
    const f = await fixture({ consent: false, quests: [quest({ kind: 'daily', chapters: [], tracked: false })] });
    const completed = (streak: number) => quest({ kind: 'daily', chapters: [], tracked: false,
      derived: { ...quest().derived, streak, dueToday: true } });
    f.emit('quest/completed', { quest: completed(2), periodKey: '2026-10-03' }); await f.drain();
    f.emit('quest/uncompleted', { quest: completed(1) }); await f.drain();
    f.emit('quest/completed', { quest: completed(2) }); await f.drain();
    expect((await f.lines()).filter(line => line.topic === 'streak')).toHaveLength(1);
    f.emit('quest/completed', { quest: completed(3) }); await f.drain();
    expect((await f.lines()).filter(line => line.topic === 'streak')).toHaveLength(2);
    expect(await f.request('scribe/epilogue', { questId: 'q1' })).toEqual({ epilogue: null });
  });
});

describe('rule-selected board and logical period cache', () => {
  const boardQuests = [quest(), quest({ id: 'side', kind: 'side', title: '今日限期', tracked: false, deadline: '2026-10-03', order: 2 }),
    quest({ id: 'old', kind: 'side', tracked: false, deadline: '2026-10-02', order: 1 }),
    quest({ id: 'daily', kind: 'daily', title: '晨课', chapters: [], tracked: false, order: 3,
      cycle: { periodKey: '2026-10-03', current: 0, done: false }, derived: { ...quest().derived, dueToday: true } }),
    quest({ id: 'off-day', kind: 'daily', chapters: [], tracked: false, derived: { ...quest().derived, dueToday: false } }),
    quest({ id: 'done', status: 'completed', tracked: false })];
  it('chooses tracked current objective, today-due side and daily; model only phrases reasons; caches concurrent opens', async () => {
    const f = await fixture({ quests: boardQuests }); f.model.mockResolvedValueOnce({ text: JSON.stringify(['先走眼前一步。', '今日这一页，先记此事。', '晨课也留一笔。']) });
    const [a, b] = await Promise.all([f.request('scribe/board', {}), f.request('scribe/board', {})]);
    expect(a).toEqual(b); expect(a.origin).toBe('model');
    expect(a.items.map(item => item.questId)).toEqual(['q1', 'side', 'daily']);
    expect(a.items[0]!.objectiveId).toBe('o1'); expect(a.items[2]!.objectiveId).toBeUndefined();
    f.setQuests([]); expect(await f.request('scribe/board', {})).toEqual(a); expect(f.model).toHaveBeenCalledOnce();
    expect(f.model.mock.calls[0]![0].messages[0]!.content).not.toContain('今日限期以外');
  });
  it('keeps builtin board cached without consent, caps at three and omits unrelated context', async () => {
    const f = await fixture({ consent: false, quests: boardQuests });
    const a = await f.request('scribe/board', {}); expect(a.origin).toBe('builtin'); expect(a.items).toHaveLength(3);
    await f.request('scribe/consent', { granted: true }); expect(await f.request('scribe/board', {})).toEqual(a);
    expect(f.model).not.toHaveBeenCalled();
  });
  it('follows quest dayStartHour, crosses weeks and refreshes after sleeping through the boundary', async () => {
    const f = await fixture({ consent: false, time: local('2026-10-04', 3) }); f.setHour(6);
    expect((await f.request('scribe/board', {})).periodKey).toBe('2026-10-03');
    f.setTime(local('2026-10-04', 5, 59), false); expect((await f.request('scribe/board', {})).periodKey).toBe('2026-10-03');
    f.setTime(local('2026-10-05', 7), false); expect((await f.request('scribe/board', {})).periodKey).toBe('2026-10-05');
  });
  it('handles empty boards and invalid reasons without allowing the model to replace task IDs', async () => {
    const empty = await fixture({ quests: [] }); expect((await empty.request('scribe/board', {})).items).toEqual([]); expect(empty.model).not.toHaveBeenCalled();
    const f = await fixture(); f.model.mockResolvedValueOnce({ text: '[{"questId":"invented"}]' });
    expect(await f.request('scribe/board', {})).toMatchObject({ origin: 'builtin', items: [{ questId: 'q1' }] });
  });
});

describe('Clock-driven stuck objectives, recaps and epilogues', () => {
  it('proposes splitting at exactly five days, once per progress signature, and does not mutate quests', async () => {
    const f = await fixture({ consent: false });
    f.setTime(local('2026-10-08') - 1); await f.drain(); expect(await f.lines()).toEqual([]);
    f.setTime(local('2026-10-08')); await f.drain();
    expect((await f.lines()).map(line => line.topic)).toEqual(['greeting']);
    f.setTime(local('2026-10-09')); await f.drain(); expect(await f.lines()).toHaveLength(1);
    expect(f.messages.some(message => message.kind === 'request' && message.type === 'quest/set-chapters')).toBe(false);
  });
  it('resets the five-day timer only for objective/count progress, not a renamed task', async () => {
    const f = await fixture({ consent: false });
    f.setTime(local('2026-10-06')); f.emit('quest/updated', { quest: quest({ title: '改名', updatedAt: new Date(local('2026-10-06')).toISOString() }), changed: ['title'] }); await f.drain();
    f.setTime(local('2026-10-08')); await f.drain(); expect(await f.lines()).toHaveLength(1);
    f.emit('quest/counted', { quest: quest({ chapters: [{ id: 'ch1', title: '开卷', objectives: [{ id: 'o1', text: '读', count: { current: 1, target: 5 } }] }] }), previous: 0, current: 1, objectiveId: 'o1' }); await f.drain();
    f.setTime(local('2026-10-12')); await f.drain(); expect(await f.lines()).toHaveLength(1);
    f.setTime(local('2026-10-13')); await f.drain(); expect(await f.lines()).toHaveLength(2);
  });
  it('defers stuck suggestions at night and honors quiet mode', async () => {
    const old = quest({ updatedAt: new Date(local('2026-09-28', 23)).toISOString() });
    const f = await fixture({ time: local('2026-10-03', 23), consent: false, quests: [old] });
    expect(await f.lines()).toEqual([]); f.setTime(local('2026-10-04', 7)); await f.drain(); expect(await f.lines()).toHaveLength(1);
    const quiet = await fixture({ consent: false, quests: [old], settings: { talkativeness: 'quiet' } });
    quiet.setTime(local('2026-10-10')); await quiet.drain(); expect(await quiet.lines()).toEqual([]);
  });
  it('writes one recap after recapTime when locally opened, keeps reads local and excludes external/self history', async () => {
    const f = await fixture({ time: local('2026-10-03', 21, 59) });
    f.emit('quest/counted', { quest: quest(), previous: 0, current: 1 });
    f.emit('quest/counted', { quest: quest({ id: 'external-q', title: '外部秘密', tracked: false }), previous: 0, current: 1 }, 'external');
    f.open(); await f.drain(); expect(f.model).not.toHaveBeenCalled();
    f.model.mockResolvedValueOnce({ text: '今日推进已记下，明日先沿眼前的目标走。' });
    f.setTime(local('2026-10-03', 22)); await f.drain();
    expect((await f.request('scribe/recap', {})).recap).toMatchObject({ periodKey: '2026-10-03' });
    const prompt = f.model.mock.calls[0]![0].messages[0]!.content;
    expect(prompt).toContain('学习'); expect(prompt).not.toContain('外部秘密');
    const a = await f.request('scribe/recap', { write: true }); expect(a.recap).not.toBeNull(); expect(f.model).toHaveBeenCalledOnce();
    expect(f.messages.filter(message => message.type === 'scribe/recap-written')).toHaveLength(1);
    expect((await f.request('scribe/recaps', { limit: 1 })).recaps).toEqual([a.recap]);
  });
  it('writes on the first local open after the configured time, not on external opens or while closed', async () => {
    const f = await fixture({ time: local('2026-10-03', 20), settings: { recapTime: 19 } });
    f.open('scribe'); await f.drain(); expect(f.model).not.toHaveBeenCalled();
    f.model.mockResolvedValueOnce({ text: '今日留白也在日志里，明日接着写。' });
    f.open(); await f.drain(); expect(f.model).toHaveBeenCalledOnce();
    f.open('user', 'collapsed'); await f.drain(); f.setTime(local('2026-10-04', 20)); await f.drain(); expect(f.model).toHaveBeenCalledOnce();
  });
  it('manual recap uses the logical period, validates dates and retries failed network later', async () => {
    const f = await fixture({ time: local('2026-10-04', 3) });
    f.model.mockRejectedValueOnce(failure('scribe/unavailable', 'offline'));
    await expect(f.request('scribe/recap', { write: true })).rejects.toMatchObject({ code: 'scribe/unavailable' });
    f.setTime(local('2026-10-04', 3) + 30_000, false);
    f.model.mockResolvedValueOnce({ text: '这一页已记，接着来。' });
    expect((await f.request('scribe/recap', { write: true })).recap).toMatchObject({ periodKey: '2026-10-03' });
    await expect(f.request('scribe/recap', { periodKey: '2026-02-29' })).rejects.toMatchObject({ code: 'scribe/invalid-input' });
    await expect(f.request('scribe/recap', { periodKey: '2099-01-01', write: true })).rejects.toMatchObject({ code: 'scribe/invalid-input' });
  });
  it('completes main/side epilogues once, caps at 200 chars and falls back on bad output', async () => {
    const f = await fixture();
    f.model.mockResolvedValueOnce({ text: '此事功成。' }).mockResolvedValueOnce({ text: '字'.repeat(201) });
    f.emit('quest/completed', { quest: quest({ status: 'completed' }) }); await f.drain();
    const ending = (await f.request('scribe/epilogue', { questId: 'q1' })).epilogue!;
    expect(ending.text.length).toBeLessThanOrEqual(200); expect(ending.text).not.toBe('字'.repeat(201));
    expect(f.messages.filter(message => message.type === 'scribe/epilogue-written')).toHaveLength(1);
    f.emit('quest/completed', { quest: quest({ status: 'completed' }) }); await f.drain();
    expect((await f.request('scribe/epilogue', { questId: 'q1' })).epilogue).toEqual(ending);
  });
  it('does not write deferred epilogues after reopening/deletion, and cleans up on unload', async () => {
    const f = await fixture({ time: local('2026-10-03', 23), consent: false });
    f.emit('quest/completed', { quest: quest({ status: 'completed' }) }); await f.drain();
    f.emit('quest/uncompleted', { quest: quest() }); await f.drain();
    f.emit('quest/deleted', { id: 'q1' }); f.setQuests([]); await f.drain();
    f.setTime(local('2026-10-04', 7)); await f.drain(); expect((await f.request('scribe/epilogue', { questId: 'q1' })).epilogue).toBeNull();
    f.kernel.unload('scribe'); expect(f.timers.size).toBe(0);
  });
  it('persists local history, consent and usage; rejects unknown storage without overwriting it', async () => {
    const f = await fixture(); await f.request('scribe/test', {}); f.kernel.unload('scribe');
    const reopened = await fixture({ data: f.data, consent: false });
    expect(await reopened.request('scribe/state', {})).toMatchObject({ consented: true, usage: { calls: 1 } });
    const data = new Map<string, Json>([['state', { version: 99 }]]);
    const invalid = await fixture({ data }); expect(invalid.failed).toBeDefined(); expect(data.get('state')).toEqual({ version: 99 });
  });
});

describe('storage round trips and startup safeguards', () => {
  it('retains lines, boards, recaps, endings and provenance history after reopening', async () => {
    const f = await fixture();
    f.emit('quest/objective-completed', { quest: quest(), chapterId: 'ch1', objectiveId: 'o1' }); await f.drain();
    f.model.mockResolvedValueOnce({ text: '["先走眼前一步。"]' }); const board = await f.request('scribe/board', {});
    f.model.mockResolvedValueOnce({ text: '今日这一笔已记，明日接着来。' }); const recap = await f.request('scribe/recap', { write: true });
    f.emit('quest/completed', { quest: quest({ status: 'completed' }) }); await f.drain();
    const ending = await f.request('scribe/epilogue', { questId: 'q1' }); const lines = await f.lines();
    f.kernel.unload('scribe');
    const reopened = await fixture({ data: f.data, consent: false });
    expect(reopened.failed).toBeUndefined(); expect(await reopened.lines()).toEqual(lines);
    expect(await reopened.request('scribe/board', {})).toEqual(board);
    expect(await reopened.request('scribe/recap', {})).toEqual(recap);
    expect(await reopened.request('scribe/epilogue', { questId: 'q1' })).toEqual(ending);
    expect(await reopened.request('scribe/epilogue', { questId: '__proto__' })).toEqual({ epilogue: null });
    expect(reopened.model).not.toHaveBeenCalled();
  });
  it('does not mistake the pre-existing streak for a new record or duplicate queued records', async () => {
    const q = quest({ kind: 'daily', chapters: [], derived: { ...quest().derived, streak: 5 } });
    const f = await fixture({ consent: false, quests: [q] });
    f.emit('quest/completed', { quest: q }); await f.drain();
    expect((await f.lines()).filter(line => line.topic === 'streak')).toHaveLength(0);
    const improved = { ...q, derived: { ...q.derived, streak: 6 } };
    f.emit('quest/completed', { quest: improved }); f.emit('quest/completed', { quest: improved }); await f.drain();
    expect((await f.lines()).filter(line => line.topic === 'streak')).toHaveLength(1);
  });
  const corruptions: [string, (data: Record<string, Json>) => void][] = [
    ['line topic', data => { data.lines = [{ id: 'x', text: '批注。', at: new Date(local()).toISOString(), topic: 'alien', origin: 'builtin' }]; }],
    ['line timestamp', data => { data.lines = [{ id: 'x', text: '批注。', at: 'not a time', topic: 'quest', origin: 'builtin' }]; }],
    ['usage count', data => { data.usage = { '2026-10': { month: '2026-10', calls: -1, inputTokens: 0, outputTokens: 0, unreported: 0 } }; }],
    ['usage month', data => { data.usage = { 'bad-month': {} }; }],
    ['progress timestamp', data => { data.progress = { q1: { signature: 'o1', at: 'yesterday', proposed: false } }; }],
    ['board items', data => { data.boards = { '2026-10-03': { periodKey: '2026-10-03', items: null, origin: 'builtin' } }; }],
    ['board origin', data => { data.boards = { '2026-10-03': { periodKey: '2026-10-03', items: [], origin: 'alien' } }; }],
    ['board reason', data => { data.boards = { '2026-10-03': { periodKey: '2026-10-03', items: [{ questId: 'q1', reason: '' }], origin: 'builtin' } }; }],
    ['recap period', data => { data.recaps = { '2026-10-03': { periodKey: '2026-10-04', text: '战报', writtenAt: new Date(local()).toISOString() } }; }],
    ['ending quest', data => { data.epilogues = { q1: { questId: 'q2', text: '尾声', writtenAt: new Date(local()).toISOString() } }; }],
    ['negative peak', data => { data.peaks = { q1: -1 }; }],
    ['activity type', data => { data.activity = [{ periodKey: '2026-10-03', questId: 'q1', title: '学习', at: new Date(local()).toISOString(), streak: 0, kind: 'other' }]; }],
    ['pending schema', data => { data.pending = [null]; }],
  ];
  it.each(corruptions)('refuses corrupt %s without rewriting the file', async (_, corrupt) => {
    const seed = await fixture({ consent: false });
    const stored = structuredClone(seed.data.get('state')) as Record<string, Json>; seed.kernel.unload('scribe');
    corrupt(stored); const data = new Map<string, Json>([['state', stored]]);
    const f = await fixture({ data }); expect(f.failed).toBeDefined(); expect(data.get('state')).toEqual(stored);
  });
  it('resumes persisted auth failure after a key changes while the app was closed', async () => {
    const f = await fixture(); f.model.mockRejectedValueOnce(failure('scribe/auth-failed', 'auth'));
    await f.request('scribe/test', {}); f.kernel.unload('scribe');
    const paused = await fixture({ data: f.data, consent: false });
    expect(await paused.request('scribe/test', {})).toMatchObject({ code: 'scribe/auth-failed' }); paused.kernel.unload('scribe');
    const changed = await fixture({ data: f.data, key: 'changed-while-closed', consent: false });
    expect(await changed.request('scribe/test', {})).toMatchObject({ ok: true });
  });
  it('does not spin a past-due stuck timer in quiet mode', async () => {
    const f = await fixture({ quests: [quest({ updatedAt: new Date(local('2026-09-20')).toISOString() })],
      settings: { talkativeness: 'quiet' }, consent: false });
    expect([...f.timers.values()].every(deadline => deadline > local() + 3_600_000)).toBe(true);
  });
  it('does not send the rest of a large quest as reaction context', async () => {
    const q = quest({ chapters: [{ id: 'ch1', title: '开卷', objectives: [
      { id: 'o1', text: '眼前一步' }, ...Array.from({ length: 20 }, (_, index) => ({ id: `later-${index}`, text: `无关未来目标${index}` })),
    ] }] });
    const f = await fixture({ quests: [q] }); f.emit('quest/objective-completed', { quest: q, chapterId: 'ch1', objectiveId: 'o1' }); await f.drain();
    const prompt = f.model.mock.calls[0]![0].messages[0]!.content;
    expect(prompt).toContain('眼前一步'); expect(prompt).not.toContain('无关未来目标');
  });
});

describe('night-time recap periods', () => {
  it.each([0, 2, 23])('defers recapTime=%i to 7:00 while retaining its original period', async hour => {
    const f = await fixture({ time: local('2026-10-03', 21), settings: { recapTime: hour } });
    f.open(); await f.drain(); expect(f.model).not.toHaveBeenCalled();
    const due = hour === 23 ? local('2026-10-03', 23) : local('2026-10-04', hour);
    f.setTime(due); await f.drain(); expect(f.model).not.toHaveBeenCalled();
    f.model.mockResolvedValueOnce({ text: '这一页已记，明日接着写。' });
    f.setTime(local('2026-10-04', 7)); await f.drain();
    expect((await f.request('scribe/recap', { periodKey: '2026-10-03' })).recap).not.toBeNull();
    expect((await f.request('scribe/recap', { periodKey: '2026-10-04' })).recap).toBeNull();
    expect(f.model).toHaveBeenCalledOnce();
  });
  it('queues the first late opening, survives restart and waits until the next local open', async () => {
    const f = await fixture({ time: local('2026-10-03', 23) }); f.open(); await f.drain();
    expect(f.model).not.toHaveBeenCalled(); f.kernel.unload('scribe');
    const resumed = await fixture({ time: local('2026-10-04', 7), data: f.data, consent: false });
    expect(resumed.model).not.toHaveBeenCalled();
    resumed.model.mockResolvedValueOnce({ text: '昨页已经记下，接着来。' }); resumed.open(); await resumed.drain();
    expect((await resumed.request('scribe/recap', { periodKey: '2026-10-03' })).recap).not.toBeNull();
  });
  it('retries a pending automatic recap at Retry-After, without repeating reactions', async () => {
    const f = await fixture({ time: local('2026-10-03', 22) });
    f.model.mockRejectedValueOnce(Object.assign(failure('scribe/unavailable', 'limited'), { retryAfterMs: 60_000 }))
      .mockResolvedValueOnce({ text: '这一页已记，接着来。' });
    f.open(); await f.drain(); expect(f.model).toHaveBeenCalledOnce();
    f.setTime(local('2026-10-03', 22) + 59_999); await f.drain(); expect(f.model).toHaveBeenCalledOnce();
    f.setTime(local('2026-10-03', 22, 1)); await f.drain(); expect(f.model).toHaveBeenCalledTimes(2);
    expect((await f.request('scribe/recap', {})).recap).not.toBeNull(); expect(await f.lines()).toEqual([]);
  });
});

it('retains unreported usage when unloading during a model call', async () => {
  const f = await fixture();
  f.model.mockImplementationOnce(() => new Promise<ModelReply>(() => {}));
  f.emit('quest/objective-completed', { quest: quest(), chapterId: 'ch1', objectiveId: 'o1' });
  await vi.waitFor(() => expect(f.model).toHaveBeenCalledOnce());
  f.kernel.unload('scribe');
  const reopened = await fixture({ data: f.data, consent: false });
  expect((await reopened.request('scribe/state', {})).usage).toMatchObject({ calls: 1, unreported: 1 });
});

it('does not generate boards or recaps for external or other-plugin requesters', async () => {
  const f = await fixture();
  for (const source of ['external:test', 'other-plugin']) {
    const bus = f.kernel.createBus(source);
    await expect(bus.request('scribe/board', {})).rejects.toMatchObject({ code: 'scribe/invalid-input' });
    await expect(bus.request('scribe/recap', { write: true })).rejects.toMatchObject({ code: 'scribe/invalid-input' });
  }
  expect(f.model).not.toHaveBeenCalled();
});

it('gives recap tomorrow suggestions real names and next-day recurrence instead of opaque IDs', async () => {
  const f = await fixture({ quests: [quest(),
    quest({ id: 'side', title: '明日限期', kind: 'side', tracked: false, deadline: '2026-10-04' }),
    quest({ id: 'sunday', title: '周日晨课', kind: 'daily', tracked: false, chapters: [],
      recurrence: { freq: 'weekly', weekdays: [0] }, cycle: { periodKey: '2026-10-03', current: 0, done: false } }),
    quest({ id: 'saturday', title: '周六专用', kind: 'daily', tracked: false, chapters: [], recurrence: { freq: 'weekly', weekdays: [6] } }),
  ] });
  f.model.mockResolvedValueOnce({ text: '明日先推进《学习》，再记《周日晨课》。' });
  expect((await f.request('scribe/recap', { write: true })).recap?.text).toContain('周日晨课');
  const prompt = f.model.mock.calls[0]![0].messages[0]!.content;
  expect(prompt).toContain('明日限期'); expect(prompt).not.toContain('周六专用');
});
