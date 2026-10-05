import type {
  Clock, Dispose, Envelope, Json, MainContext, Quest, QuestRequests, RequestPayload,
  ResponseData, ScribeBoard, ScribeEpilogue, ScribeErrorCode, ScribeLine, ScribeRecap,
  ScribeRequests, ScribeState, ScribeTopic, ScribeUsage,
} from '@featherlog/contracts';
import { anthropicClient, endpoint, failure, openAIClient, record } from './model';
import type { ModelClient, ModelConfig, ModelReply } from './model';
import {
  builtin, context, currentObjective, DRAFT_PROMPT, EPILOGUE_PROMPT, epilogueTitle, PERSONA, prose, questDraft,
  SPLIT_PROMPT, splitDraft, text, validDate,
} from './writing';

interface Progress { signature: string; at: number; proposed: boolean }
interface Activity {
  periodKey: string; questId: string; title: string; kind: string; at: string; streak: number;
  objective?: string; previous?: number; current?: number;
}
interface State {
  version: 1;
  consentEndpoint: string | null;
  consentNotes: boolean;
  auth: { signature: string; message: string } | null;
  usage: Record<string, ScribeUsage>;
  lines: ScribeLine[];
  boards: Record<string, ScribeBoard>;
  recaps: Record<string, ScribeRecap>;
  epilogues: Record<string, ScribeEpilogue>;
  progress: Record<string, Progress>;
  peaks: Record<string, number>;
  activity: Activity[];
  pending: string[];
  pendingRecaps: string[];
}
const fresh = (): State => ({ version: 1, consentEndpoint: null, consentNotes: false, auth: null, usage: {}, lines: [],
  boards: {}, recaps: {}, epilogues: {}, progress: {}, peaks: {}, activity: [], pending: [], pendingRecaps: [] });
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
function timestamp(value: unknown) {
  if (typeof value !== 'string' || !value.includes('T') || !Number.isFinite(Date.parse(value))) {
    throw failure('scribe/unusable-reply', '时间记录无法使用。');
  }
}
function nonnegative(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw failure('scribe/unusable-reply', '计数记录无法使用。');
  }
}
function load(value: Json | undefined): State {
  if (value === undefined) return fresh();
  const data = record(value);
  const valid = data.version === 1 && (data.consentEndpoint === null || typeof data.consentEndpoint === 'string') &&
    (data.consentNotes === undefined || typeof data.consentNotes === 'boolean') &&
    (data.auth === null || (typeof record(data.auth).signature === 'string' && typeof record(data.auth).message === 'string')) &&
    Array.isArray(data.lines) && Array.isArray(data.activity) && Array.isArray(data.pending) &&
    data.pending.every(id => typeof id === 'string') && Array.isArray(data.pendingRecaps);
  if (!valid) throw failure('scribe/unusable-reply', '书记官存储版本或格式无法使用。');
  for (const key of data.pendingRecaps as unknown[]) validDate(key);
  for (const key of ['usage', 'boards', 'recaps', 'epilogues', 'progress', 'peaks']) record(data[key]);
  // Validate persisted messages before they can cross the bus or enter a prompt.
  for (const entry of data.lines as unknown[]) {
    const line = record(entry);
    text(line.id, 'id', Infinity, true); text(line.text, '批注', 40, true); timestamp(line.at);
    if (line.questId !== undefined) text(line.questId, 'questId', Infinity, true);
    if (typeof line.topic !== 'string' || !['objective', 'chapter', 'quest', 'streak', 'reopen', 'board', 'greeting', 'stall'].includes(line.topic) ||
      (line.origin !== 'model' && line.origin !== 'builtin')) throw failure('scribe/unusable-reply', '批注记录无法使用。');
  }
  for (const [key, entry] of Object.entries(record(data.usage))) {
    const usage = record(entry);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key) || usage.month !== key) {
      throw failure('scribe/unusable-reply', '用量月份无法使用。');
    }
    for (const key of ['calls', 'inputTokens', 'outputTokens', 'unreported']) {
      nonnegative(usage[key]);
    }
  }
  for (const [key, entry] of Object.entries(record(data.boards))) {
    validDate(key);
    const board = record(entry);
    if (board.periodKey !== key || !Array.isArray(board.items) || board.items.length > 3 ||
      (board.origin !== 'model' && board.origin !== 'builtin')) throw failure('scribe/unusable-reply', '委托板记录无法使用。');
    for (const entry of board.items) {
      const item = record(entry);
      text(item.questId, 'questId', Infinity, true); text(item.reason, '理由', 40, true);
      if (item.objectiveId !== undefined) text(item.objectiveId, 'objectiveId', Infinity, true);
    }
  }
  for (const [key, entry] of Object.entries(record(data.recaps))) {
    validDate(key); const recap = record(entry);
    if (recap.periodKey !== key) throw failure('scribe/unusable-reply', '战报日期无法使用。');
    text(recap.text, '战报', 4000, true); timestamp(recap.writtenAt);
  }
  for (const [key, entry] of Object.entries(record(data.epilogues))) {
    const epilogue = record(entry);
    if (epilogue.questId !== key) throw failure('scribe/unusable-reply', '尾声任务无法使用。');
    text(epilogue.text, '尾声', 200, true); timestamp(epilogue.writtenAt);
    const title = epilogueTitle(epilogue.title);
    if (title === undefined) delete epilogue.title;
    else epilogue.title = title;
  }
  for (const entry of Object.values(record(data.progress))) {
    const progress = record(entry);
    if (typeof progress.signature !== 'string' || typeof progress.at !== 'number' || !Number.isFinite(progress.at) ||
      typeof progress.proposed !== 'boolean') throw failure('scribe/unusable-reply', '进度记录无法使用。');
  }
  for (const peak of Object.values(record(data.peaks))) nonnegative(peak);
  for (const entry of data.activity as unknown[]) {
    const activity = record(entry);
    validDate(activity.periodKey); timestamp(activity.at); nonnegative(activity.streak);
    text(activity.questId, 'questId', Infinity, true); text(activity.title, '任务', 200, true);
    if (typeof activity.kind !== 'string' || !activity.kind.startsWith('quest/')) {
      throw failure('scribe/unusable-reply', '进展类型无法使用。');
    }
    if (activity.objective !== undefined) text(activity.objective, '目标', Infinity, true);
    if (activity.previous !== undefined) nonnegative(activity.previous);
    if (activity.current !== undefined) nonnegative(activity.current);
  }
  return { ...structuredClone(value) as unknown as State, consentNotes: data.consentNotes === true };
}
function dateKey(time: number) {
  const date = new Date(time);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function night(time: number) { const hour = new Date(time).getHours(); return hour >= 23 || hour < 7; }
function nextHour(clock: Clock, hour: number) {
  const date = new Date(clock.now());
  date.setHours(hour, 0, 0, 0);
  if (date.getTime() <= clock.now()) date.setDate(date.getDate() + 1);
  return date.getTime();
}
function inputError(message = '请求参数无法使用。') { return failure('scribe/invalid-input', message); }
function parameter(value: unknown): Record<string, unknown> {
  try { return record(value); } catch { throw inputError(); }
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw inputError();
  return value;
}
function limit(value: unknown) {
  if (value === undefined) return 20;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100) throw inputError();
  return value;
}
function code(cause: unknown): ScribeErrorCode {
  if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string' &&
    ['scribe/not-configured', 'scribe/no-consent', 'scribe/auth-failed', 'scribe/unavailable',
      'scribe/unusable-reply', 'scribe/invalid-input'].includes(cause.code)) return cause.code as ScribeErrorCode;
  return 'scribe/unavailable';
}

export async function setup(ctx: MainContext): Promise<void> {
  let state = load(await ctx.storage.get('state'));
  let disposed = false;
  let revision = 0;
  let retryAt = 0;
  let failures = 0;
  let lastObjective = -Infinity;
  let panelOpen = false;
  let timer: Dispose = () => {};
  let writes = Promise.resolve();
  let jobs = Promise.resolve();
  const controllers = new Set<AbortController>();
  const boardCalls = new Map<string, Promise<ScribeBoard>>();
  const recapCalls = new Map<string, Promise<ScribeRecap>>();
  const openai = openAIClient(ctx.clock);
  const anthropic = anthropicClient(ctx.clock);
  const client: ModelClient = request =>
    request.config.protocol === 'openai' ? openai(request) : anthropic(request);
  const local = (message: Envelope) => message.origin === 'quest';
  const persist = (change: (draft: State) => void) => {
    const result = writes.then(async () => {
      if (disposed) return;
      const draft = structuredClone(state);
      change(draft);
      // ponytail: one atomic journal record; split records if years of local history make writes expensive.
      await ctx.storage.set('state', json(draft));
      state = draft;
    });
    writes = result.catch(() => {});
    return result;
  };
  const queue = (work: () => Promise<void>) => {
    jobs = jobs.then(async () => { if (!disposed) await work(); }).catch(() => {
      if (!disposed) ctx.log.warn('Scribe action could not be completed');
    });
  };
  const nowISO = () => new Date(ctx.clock.now()).toISOString();
  const month = () => dateKey(ctx.clock.now()).slice(0, 7);
  const currentUsage = (): ScribeUsage => state.usage[month()] ?? {
    month: month(), calls: 0, inputTokens: 0, outputTokens: 0, unreported: 0,
  };
  const configuration = async (): Promise<{ config?: ModelConfig; address?: string; signature: string }> => {
    const protocol = ctx.settings.get('protocol');
    const baseUrl = ctx.settings.get('baseUrl');
    const model = ctx.settings.get('model');
    let apiKey: string | undefined;
    try { apiKey = await ctx.secrets.get('apiKey'); } catch { /* Unreadable secrets cannot authorize networking. */ }
    const raw = JSON.stringify([protocol ?? null, baseUrl ?? null, model ?? null, apiKey ?? null]);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    const signature = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (typeof baseUrl !== 'string') return { signature };
    let url: URL;
    try { url = endpoint(baseUrl); } catch { return { signature }; }
    const address = url.href.replace(/\/$/, '');
    if ((protocol !== 'openai' && protocol !== 'anthropic') || typeof model !== 'string' || !model.trim() ||
      (!apiKey && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')) return { address, signature };
    return { address, signature, config: { protocol, baseUrl: address, model, ...(apiKey ? { apiKey } : {}) } };
  };
  const enabled = () => ctx.settings.get('enabled') === true;
  const readNotes = () => ctx.settings.get('readNotes') === true;
  const consented = (address: string | undefined) => address !== undefined && state.consentEndpoint === address &&
    (!readNotes() || state.consentNotes);
  const checkRevision = (stamp: number) => {
    if (stamp !== revision || disposed) throw failure('scribe/unavailable', '配置已改变，请重试。');
  };
  const snapshot = async (): Promise<ScribeState> => {
    const settings = await configuration();
    return { enabled: enabled(), consented: consented(settings.address),
      configured: settings.config !== undefined, ...(settings.address ? { endpoint: settings.address } : {}),
      ...(state.auth && state.auth.signature === settings.signature
        ? { paused: { reason: 'auth' as const, message: state.auth.message } } : {}), usage: { ...currentUsage() } };
  };
  const changed = async () => {
    if (!disposed) ctx.bus.emit('scribe/state-changed', { state: await snapshot() });
  };
  const gate = async () => {
    const settings = await configuration();
    if (!consented(settings.address)) throw failure('scribe/no-consent', readNotes()
      ? '手记也会发送给所配置的接口，请先重新同意。' : '请先同意将必要的任务资料发送到此接口。');
    if (!enabled() || !settings.config) throw failure('scribe/not-configured', '请先启用并配置翎的接口、模型和密钥。');
    if (state.auth?.signature === settings.signature) throw failure('scribe/auth-failed', '密钥不对，请检查配置。');
    if (ctx.clock.now() < retryAt) throw failure('scribe/unavailable', '接口正在歇笔，稍后再试。');
    return settings as typeof settings & { config: ModelConfig };
  };
  const invoke = async (prompt: string, maxTokens: number, stream = false, previous?: { reply: string; error: string }): Promise<ModelReply> => {
    const stamp = revision;
    const settings = await gate();
    if (stamp !== revision || disposed) throw failure('scribe/unavailable', '配置已改变，请重试。');
    const controller = new AbortController();
    controllers.add(controller);
    const callMonth = month();
    let reported: ModelReply['usage'];
    let cancel: Dispose = () => {};
    try {
      // Reserve an unknown-usage attempt before sending, so shutdown cannot erase a paid call.
      await persist(draft => {
        const usage = draft.usage[callMonth] ?? { month: callMonth, calls: 0, inputTokens: 0, outputTokens: 0, unreported: 0 };
        usage.calls++; usage.unreported++; draft.usage[callMonth] = usage;
      });
      if (stamp !== revision || disposed || controller.signal.aborted) {
        throw failure('scribe/unavailable', '配置已改变，请重试。');
      }
      const timeout = new Promise<never>((_, reject) => {
        cancel = ctx.clock.setTimeout(() => {
          controller.abort(); reject(failure('scribe/unavailable', '接口超过30秒未回复。'));
        }, 30_000);
        controller.signal.addEventListener('abort', () => reject(failure('scribe/unavailable', '请求已停止。')), { once: true });
      });
      const reply = await Promise.race([client({ config: settings.config, prefix: PERSONA,
        messages: [{ role: 'user', content: prompt }, ...(previous ? [
          { role: 'assistant' as const, content: previous.reply },
          { role: 'user' as const, content: `回复校验失败：${previous.error}\n请按原结构重新输出JSON，修正错误。` },
        ] : [])], maxTokens, stream, signal: controller.signal }), timeout]);
      reported = reply.usage;
      if (stamp !== revision || disposed) throw failure('scribe/unavailable', '配置已改变，请重试。');
      failures = 0; retryAt = 0;
      return reply;
    } catch (cause) {
      if (stamp === revision && !disposed) {
        if (code(cause) === 'scribe/auth-failed') {
          await persist(draft => { draft.auth = { signature: settings.signature, message: '密钥不对，请检查配置。' }; });
        } else if (code(cause) === 'scribe/unavailable') {
          const metadata = cause !== null && typeof cause === 'object' ? cause as Record<string, unknown> : {};
          if (metadata.retryable !== false) {
            failures++;
            const retry = typeof metadata.retryAfterMs === 'number' && Number.isFinite(metadata.retryAfterMs)
              ? Math.max(0, metadata.retryAfterMs) : Math.min(3_600_000, 30_000 * 2 ** Math.min(failures - 1, 7));
            retryAt = ctx.clock.now() + retry;
          }
        }
      }
      throw failure(code(cause), code(cause) === 'scribe/auth-failed' ? '密钥不对，请检查配置。' :
        code(cause) === 'scribe/unusable-reply' ? '没写成，换个说法试试。' : '接口暂时无法回复，稍后再试。');
    } finally {
      cancel(); controllers.delete(controller);
      if (!disposed) {
        const tokens = reported;
        if (tokens) await persist(draft => {
          const usage = draft.usage[callMonth]!;
          usage.inputTokens += tokens.inputTokens; usage.outputTokens += tokens.outputTokens; usage.unreported--;
        });
        await changed();
      }
    }
  };
  const structured = async <T>(prompt: string, validate: (reply: Record<string, unknown>) => T): Promise<T> => {
    let previous: { reply: string; error: string } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await invoke(prompt, 2500, false, previous);
      try { return validate(record(JSON.parse(reply.text))); }
      catch (cause) {
        previous = { reply: reply.text, error: cause instanceof Error && 'code' in cause ? cause.message : '回复不是有效JSON。' };
      }
    }
    throw failure('scribe/unusable-reply', '没写成，换个说法试试。');
  };
  const questRequest = async <K extends keyof QuestRequests>(type: K, payload: RequestPayload<K>): Promise<ResponseData<K>> => {
    try { return await ctx.bus.request(type, payload); }
    catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'quest/not-found') throw inputError('任务不存在。');
      throw failure('scribe/unavailable', '暂时无法读取日志。');
    }
  };
  const period = () => questRequest('quest/period', {});
  const quests = async () => (await questRequest('quest/list', {})).quests;
  const note = (value: unknown, facts: unknown) => value === undefined ? {} : { note: prose(value, facts, 2000) };
  const handnotes = async (ids: string[], stamp: number) => {
    if (!readNotes()) return {};
    await gate(); checkRevision(stamp);
    const notes: { questId: string; text: string; createdAt: string }[] = [];
    for (const id of new Set(ids)) {
      checkRevision(stamp);
      const result = await ctx.bus.request('notes/list', { questId: id, limit: 5 }).catch(() => {
        throw failure('scribe/unavailable', '暂时无法读取手记，请稍后再试。');
      });
      checkRevision(stamp);
      notes.push(...result.notes.filter(note => note.questId === id).slice(0, 5)
        .map(note => ({ questId: id, text: Array.from(note.text).slice(0, 300).join(''), createdAt: note.createdAt })));
    }
    return { handnotes: notes };
  };
  const say = async (topic: ScribeTopic, quest: Quest, at: number) => {
    if (!enabled() || night(at) || night(ctx.clock.now())) return;
    const stamp = revision;
    let written = builtin(topic, state.lines.length);
    let origin: ScribeLine['origin'] = 'builtin';
    const facts = context(quest);
    try {
      const reply = await invoke(`为${topic}写一句回应，只输出中文批注。日志事实：${JSON.stringify(facts)}`, 100, true);
      written = prose(reply.text, facts, 40, true); origin = 'model';
    } catch { /* The margin still has a voice while offline or awaiting consent. */ }
    if (disposed || stamp !== revision || !enabled() || night(ctx.clock.now())) return;
    const line: ScribeLine = { id: globalThis.crypto.randomUUID(), text: written, topic,
      questId: quest.id, at: nowISO(), origin };
    await persist(draft => { draft.lines.push(line); });
    if (!disposed && stamp === revision && enabled() && !night(ctx.clock.now())) ctx.bus.emit('scribe/said', { line });
  };
  const epilogue = async (quest: Quest) => {
    if (quest.kind === 'daily' || state.epilogues[quest.id] || !enabled()) return;
    if (night(ctx.clock.now())) { await persist(draft => { if (!draft.pending.includes(quest.id)) draft.pending.push(quest.id); }); return; }
    const stamp = revision;
    let written = '这一卷写到功成，走过的路留在日志里。鹅毛笔收好了，下一卷由你落笔。';
    let title: string | undefined;
    try {
      const facts = { ...context(quest), ...await handnotes([quest.id], stamp) };
      checkRevision(stamp);
      if (quest.kind === 'main') {
        const reply = await invoke(`${EPILOGUE_PROMPT}\n日志：${JSON.stringify(facts)}`, 600);
        const body = reply.text.trim().replace(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i, '$1').trim();
        try {
          const result = record(JSON.parse(body));
          written = prose(result.text, facts, 200);
          title = epilogueTitle(result.title);
        } catch {
          // A formatting failure must not discard an otherwise usable ending.
          written = prose(body, facts, 200);
        }
      } else {
        written = prose((await invoke(`依据日志写不超过200字的中文尾声，只输出正文：${JSON.stringify(facts)}`, 600)).text, facts, 200);
      }
    }
    catch { /* A completed quest keeps its ending even without an endpoint. */ }
    if (disposed || stamp !== revision || !enabled()) return;
    if (night(ctx.clock.now())) { await persist(draft => { if (!draft.pending.includes(quest.id)) draft.pending.push(quest.id); }); return; }
    const ending: ScribeEpilogue = { questId: quest.id, text: written, writtenAt: nowISO(),
      ...(title === undefined ? {} : { title }) };
    await persist(draft => { draft.epilogues[quest.id] = ending; draft.pending = draft.pending.filter(id => id !== quest.id); });
    if (!disposed && stamp === revision && enabled() && !night(ctx.clock.now())) ctx.bus.emit('scribe/epilogue-written', { epilogue: ending });
  };
  const choose = (list: Quest[], key: string, upcoming = false): ScribeBoard['items'] => {
    const active = list.filter(quest => quest.status === 'active').sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const tracked = active.find(quest => quest.tracked && currentObjective(quest));
    const side = active.filter(quest => quest.id !== tracked?.id && quest.kind === 'side' && quest.deadline === key)[0];
    const weekday = new Date(`${key}T12:00:00`).getDay();
    const daily = active.filter(quest => quest.kind === 'daily' && (upcoming
      ? quest.recurrence?.freq === 'daily' || (quest.recurrence?.freq === 'weekly' && quest.recurrence.weekdays.includes(weekday))
      : quest.derived.dueToday && !quest.cycle?.done));
    return [tracked, side, ...daily].filter((quest): quest is Quest => quest !== undefined).slice(0, 3)
      .map((quest, index) => ({ questId: quest.id,
        ...(currentObjective(quest) ? { objectiveId: currentObjective(quest)!.id } : {}), reason: builtin('board', index) }));
  };
  const board = async (): Promise<ScribeBoard> => {
    const { periodKey } = await period();
    if (state.boards[periodKey]) return structuredClone(state.boards[periodKey]);
    const existing = boardCalls.get(periodKey);
    if (existing) return existing;
    const work = (async () => {
      const list = await quests();
      const items = choose(list, periodKey);
      const facts = items.map(item => context(list.find(quest => quest.id === item.questId)!));
      let origin: ScribeBoard['origin'] = 'builtin';
      const stamp = revision;
      if (items.length) {
        try {
          const reply = await invoke(`这些是规则已选好的今日委托，请保持顺序，只输出JSON字符串数组，每项为一句不超过40字的理由，不选别的任务：${JSON.stringify(facts)}`, 300);
          const reasons: unknown = JSON.parse(reply.text);
          if (!Array.isArray(reasons) || reasons.length !== items.length) throw failure('scribe/unusable-reply', '理由数量不符。');
          const validated = reasons.map(reason => prose(reason, facts, 40, true));
          if (stamp === revision) { items.forEach((item, index) => { item.reason = validated[index]!; }); origin = 'model'; }
        } catch { /* Rule-selected tasks remain useful without generated wording. */ }
      }
      const result: ScribeBoard = { periodKey, items, origin };
      await persist(draft => { draft.boards[periodKey] = result; });
      return result;
    })();
    boardCalls.set(periodKey, work);
    try { return structuredClone(await work); } finally { boardCalls.delete(periodKey); }
  };
  const writeRecap = async (key: string): Promise<ScribeRecap> => {
    if (state.recaps[key]) return state.recaps[key];
    const existing = recapCalls.get(key);
    if (existing) return existing;
    const work = (async () => {
      const stamp = revision;
      await gate();
      const facts = state.activity.filter(activity => activity.periodKey === key);
      const list = await quests();
      const tomorrow = new Date(`${key}T12:00:00`);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const selected = choose(list, dateKey(tomorrow.getTime()), true);
      const next = selected.map(item => ({ reason: item.reason,
        quest: context(list.find(quest => quest.id === item.questId)!) }));
      const ids = [...facts.map(activity => activity.questId), ...selected.map(item => item.questId)]
        .filter(id => list.some(quest => quest.id === id));
      const source = { periodKey: key, progress: facts, suggested: next, ...await handnotes(ids, stamp) };
      checkRevision(stamp);
      const reply = await invoke(`写一页中文战报，只输出正文。只用这些本机进展，未记录的历史不要补写；明日建议是提议，不是事实：${JSON.stringify(source)}`, 1800);
      const recap: ScribeRecap = { periodKey: key, text: prose(reply.text, source, 4000), writtenAt: nowISO() };
      if (stamp !== revision || disposed) throw failure('scribe/unavailable', '配置已改变，请重试。');
      await persist(draft => { draft.recaps[key] = recap; draft.pendingRecaps = draft.pendingRecaps.filter(period => period !== key); });
      if (!disposed) ctx.bus.emit('scribe/recap-written', { recap });
      return recap;
    })();
    recapCalls.set(key, work);
    try { return await work; } finally { recapCalls.delete(key); }
  };
  const updateProgress = async (list: Quest[]) => {
    await persist(draft => {
      const live = new Set(list.map(quest => quest.id));
      for (const id of Object.keys(draft.progress)) if (!live.has(id)) delete draft.progress[id];
      for (const quest of list) {
        const objective = currentObjective(quest);
        if (quest.status !== 'active' || !objective) { delete draft.progress[quest.id]; continue; }
        const signature = JSON.stringify([objective.id, objective.count?.current ?? null]);
        const old = draft.progress[quest.id];
        if (old?.signature === signature) continue;
        const initial = Date.parse(quest.updatedAt);
        draft.progress[quest.id] = { signature, at: old ? ctx.clock.now() : Math.min(ctx.clock.now(), initial), proposed: false };
      }
    });
  };
  const schedule = () => {
    timer();
    if (disposed || !enabled()) return;
    const now = ctx.clock.now();
    let deadline = nextHour(ctx.clock, 7);
    for (const progress of Object.values(state.progress)) {
      if (!night(now) && ctx.settings.get('talkativeness') !== 'quiet' && !progress.proposed) {
        deadline = Math.min(deadline, Math.max(now + 1, progress.at + 5 * 86_400_000));
      }
    }
    if (panelOpen) deadline = Math.min(deadline, nextHour(ctx.clock, Number(ctx.settings.get('recapTime') ?? 22)));
    if (!night(now) && panelOpen && state.pendingRecaps.length && retryAt > now) deadline = Math.min(deadline, retryAt);
    timer = ctx.clock.setTimeout(() => { queue(checkTime); }, Math.max(1, deadline - now));
  };
  const checkTime = async () => {
    if (disposed || !enabled()) return;
    try {
      const list = await quests();
      await updateProgress(list);
      const { periodKey, dayStartHour } = await period();
      const time = new Date(ctx.clock.now()).getHours();
      const recapHour = Number(ctx.settings.get('recapTime') ?? 22);
      // After-midnight recap times belong to the preceding logical quest day.
      const after = recapHour >= dayStartHour ? (time >= recapHour || time < dayStartHour)
        : time >= recapHour && time < dayStartHour;
      if (panelOpen && after && !state.recaps[periodKey] && !state.pendingRecaps.includes(periodKey)) {
        await persist(draft => { draft.pendingRecaps.push(periodKey); });
      }
      if (!night(ctx.clock.now())) {
        for (const id of state.pending) {
          const actual = list.find(item => item.id === id);
          if (actual?.status === 'completed') await epilogue(actual);
          else await persist(draft => { draft.pending = draft.pending.filter(key => key !== id); });
        }
        if (ctx.settings.get('talkativeness') !== 'quiet') {
          for (const [id, progress] of Object.entries(state.progress)) {
            if (progress.proposed || ctx.clock.now() - progress.at < 5 * 86_400_000) continue;
            const quest = list.find(item => item.id === id);
            if (!quest) continue;
            await say('stall', quest, ctx.clock.now());
            if (!disposed) await persist(draft => { if (draft.progress[id]) draft.progress[id]!.proposed = true; });
          }
        }
        if (panelOpen) for (const key of state.pendingRecaps) {
          try { await writeRecap(key); } catch { /* Pending pages wait for a later opening or cooldown. */ }
        }
      }
    } finally { schedule(); }
  };
  const register = <K extends keyof ScribeRequests>(type: K, work: (payload: RequestPayload<K>, envelope: Envelope) => Promise<ResponseData<K>>) => {
    ctx.bus.handle(type, (payload, envelope) => { parameter(payload); return work(payload, envelope); });
  };
  const localRequest = (envelope: Envelope) => {
    if (!['quest', 'scribe', 'shell'].includes(envelope.source)) throw inputError('请在本机界面请求委托板或战报。');
  };
  register('scribe/state', snapshot);
  register('scribe/consent', async payload => {
    if (typeof payload.granted !== 'boolean') throw inputError();
    const stamp = revision;
    const notes = readNotes();
    const settings = payload.granted ? await configuration() : null;
    if (payload.granted) {
      checkRevision(stamp);
      if (!settings?.address) throw failure('scribe/not-configured', '请先填写有效的接口地址。');
    }
    revision++; controllers.forEach(controller => controller.abort());
    await persist(draft => {
      draft.consentEndpoint = settings?.address ?? null;
      draft.consentNotes = payload.granted && notes;
    });
    await changed(); schedule(); return snapshot();
  });
  register('scribe/test', async () => {
    const start = ctx.clock.now();
    try {
      const config = await gate();
      await invoke('只回复一个中文字：好。', 8);
      return { ok: true as const, model: config.config.model, ms: Math.max(0, ctx.clock.now() - start) };
    } catch (cause) { return { ok: false as const, code: code(cause), message: code(cause) !== 'scribe/unavailable' && cause instanceof Error ? cause.message : '接口暂时无法回复。' }; }
  });
  register('scribe/draft-quest', async payload => {
    if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 2000) throw inputError('请用不超过2000字描述任务。');
    return structured(`${DRAFT_PROMPT}\n今天：${dateKey(ctx.clock.now())}\n用户想做：${payload.text}`, reply => {
      const input = questDraft(reply.input);
      return { input, ...note(reply.note, input) };
    });
  });
  register('scribe/split-objective', async payload => {
    await gate();
    const quest = (await questRequest('quest/get', { id: identifier(payload.questId) })).quest;
    const objective = currentObjective(quest);
    if (quest.status !== 'active' || !objective || objective.id !== identifier(payload.objectiveId)) throw inputError('只能拆分当前未完成的目标。');
    return structured(`${SPLIT_PROMPT}\n任务：${JSON.stringify({ title: quest.title, objective })}`, reply => {
      const objectives = splitDraft(reply.objectives);
      return { objectives, ...note(reply.note, { objectives, title: quest.title, objective }) };
    });
  });
  register('scribe/board', async (_, envelope) => { localRequest(envelope); return board(); });
  register('scribe/recap', async (payload, envelope) => {
    if (payload.write) localRequest(envelope);
    if (payload.write !== undefined && typeof payload.write !== 'boolean') throw inputError();
    let key: string;
    try { key = payload.periodKey === undefined ? (await period()).periodKey : validDate(payload.periodKey); }
    catch (cause) { if (code(cause) === 'scribe/unusable-reply') throw inputError('日期无效。'); throw cause; }
    if (key > (await period()).periodKey) throw inputError('不能写未来的战报。');
    return { recap: state.recaps[key] ?? (payload.write ? await writeRecap(key) : null) };
  });
  register('scribe/recaps', async payload => ({ recaps: Object.values(state.recaps)
    .sort((a, b) => b.periodKey.localeCompare(a.periodKey)).slice(0, limit(payload.limit)) }));
  register('scribe/epilogue', async payload => {
    const id = identifier(payload.questId);
    return { epilogue: Object.hasOwn(state.epilogues, id) ? state.epilogues[id]! : null };
  });
  register('scribe/lines', async payload => {
    const id = payload.questId === undefined ? undefined : identifier(payload.questId);
    return { lines: state.lines.filter(line => id === undefined || line.questId === id).slice(-limit(payload.limit)).reverse() };
  });
  const settingChange = () => {
    revision++; controllers.forEach(controller => controller.abort()); retryAt = 0; failures = 0;
    queue(async () => { await persist(draft => { draft.auth = null; }); await changed(); await checkTime(); });
  };
  ctx.settings.onChange(key => {
    if (['protocol', 'baseUrl', 'model', 'enabled'].includes(key)) settingChange();
    else if (key === 'readNotes') {
      revision++; controllers.forEach(controller => controller.abort());
      queue(async () => { await changed(); await checkTime(); });
    }
    else schedule();
  });
  ctx.secrets.onChange(key => { if (key === 'apiKey') settingChange(); });
  ctx.bus.on('kernel/ready', () => { queue(async () => {
    const list = await quests();
    await persist(draft => {
      for (const quest of list) draft.peaks[quest.id] = Math.max(draft.peaks[quest.id] ?? 0, quest.derived.streak);
    });
    await changed(); await checkTime();
  }); });
  ctx.bus.on('shell/view-changed', (payload, envelope) => {
    if (payload.view !== 'panel') { panelOpen = false; schedule(); return; }
    if (!local(envelope)) return;
    panelOpen = true;
    queue(checkTime);
  });
  const react = (topic: ScribeTopic, quest: Quest, at: number) => {
    const level = ctx.settings.get('talkativeness') ?? 'normal';
    if (!enabled() || night(at) || (level === 'quiet' && topic !== 'chapter' && topic !== 'quest')) return;
    if (topic === 'objective' && level === 'normal') {
      if (at - lastObjective < 180_000) return;
      lastObjective = at;
    }
    queue(() => say(topic, quest, at));
  };
  for (const type of ['quest/created', 'quest/updated', 'quest/objective-completed', 'quest/objective-reopened',
    'quest/chapter-completed', 'quest/completed', 'quest/uncompleted', 'quest/counted'] as const) {
    ctx.bus.on(type, (payload, envelope) => {
      if (!local(envelope)) return;
      const quest = payload.quest;
      const at = envelope.time;
      queue(async () => {
        const { periodKey } = await period();
        await persist(draft => {
          const objectiveId = 'objectiveId' in payload ? payload.objectiveId : undefined;
          const objective = quest.chapters.flatMap(chapter => chapter.objectives).find(item => item.id === objectiveId);
          draft.activity.push({ periodKey, questId: quest.id, title: quest.title, kind: type,
            at: new Date(at).toISOString(), streak: quest.derived.streak,
            ...(objective ? { objective: objective.text } : {}),
            ...(type === 'quest/counted' && 'previous' in payload ? { previous: payload.previous, current: payload.current } : {}) });
          if (quest.status !== 'completed') draft.pending = draft.pending.filter(id => id !== quest.id);
        });
        await updateProgress(await quests());
        schedule();
      });
      if (type === 'quest/objective-completed') react('objective', quest, at);
      if (type === 'quest/chapter-completed') react('chapter', quest, at);
      if (type === 'quest/completed') {
        react('quest', quest, at);
        queue(() => epilogue(quest));
        queue(async () => {
          const peak = quest.derived.streak;
          if (peak <= (state.peaks[quest.id] ?? 0)) return;
          await persist(draft => { draft.peaks[quest.id] = peak; });
          react('streak', quest, at);
        });
      }
      if (type === 'quest/objective-reopened' || type === 'quest/uncompleted') react('reopen', quest, at);
    });
  }
  ctx.bus.on('quest/deleted', (payload, envelope) => {
    if (!local(envelope)) return;
    queue(async () => { await persist(draft => {
      delete draft.progress[payload.id]; draft.pending = draft.pending.filter(id => id !== payload.id);
    }); schedule(); });
  });
  ctx.bus.on('quest/period-rolled', () => { queue(checkTime); });
  ctx.onDispose(() => {
    disposed = true; revision++; timer(); controllers.forEach(controller => controller.abort());
  });
}
