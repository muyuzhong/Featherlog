import type { Clock, ScribeErrorCode } from '@featherlog/contracts';

export interface ModelConfig {
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  apiKey?: string;
}
export interface ModelRequest {
  config: ModelConfig;
  prefix: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  stream: boolean;
  signal: AbortSignal;
  onText?: (text: string) => void;
}
export interface ModelReply {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export type ModelClient = (request: ModelRequest) => Promise<ModelReply>;

export function failure(code: ScribeErrorCode, message: string) {
  return Object.assign(new Error(message), { code });
}
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('scribe/unusable-reply', '回复格式无法使用。');
  }
  return value as Record<string, unknown>;
}
export function endpoint(baseUrl: string): URL {
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw failure('scribe/not-configured', '请填写有效的接口地址。'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username || url.password || url.search || url.hash) {
    throw failure('scribe/not-configured', '接口须使用 HTTPS，本机地址可使用 HTTP。');
  }
  return url;
}
function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function usage(value: unknown, protocol: ModelConfig['protocol']): ModelReply['usage'] {
  if (value === null || typeof value !== 'object') return undefined;
  const data = record(value);
  const input = tokens(data[protocol === 'openai' ? 'prompt_tokens' : 'input_tokens']);
  const output = tokens(data[protocol === 'openai' ? 'completion_tokens' : 'output_tokens']);
  if (input === undefined || output === undefined) return undefined;
  return { inputTokens: input + (protocol === 'anthropic'
    ? (tokens(data.cache_read_input_tokens) ?? 0) + (tokens(data.cache_creation_input_tokens) ?? 0) : 0),
  outputTokens: output };
}
function decode(data: string): Record<string, unknown> {
  try { return record(JSON.parse(data)); }
  catch { throw failure('scribe/unusable-reply', '接口返回了无法解析的内容。'); }
}

async function* events(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lines: string[] = [];
  const line = (value: string) => {
    if (value.endsWith('\r')) value = value.slice(0, -1);
    if (value.startsWith('data:')) lines.push(value.slice(5).replace(/^ /, ''));
    if (value !== '') return undefined;
    const data = lines.length ? lines.join('\n') : undefined;
    lines = [];
    return data;
  };
  try {
    while (true) {
      const part = await reader.read();
      buffer += decoder.decode(part.value, { stream: !part.done });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const data = line(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (data !== undefined) yield data;
      }
      if (part.done) break;
    }
    if (buffer) line(buffer);
    if (lines.length) yield lines.join('\n');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function send(
  input: ModelRequest, clock: Clock, fetcher: typeof fetch, protocol: ModelConfig['protocol'],
): Promise<ModelReply> {
  const url = endpoint(input.config.baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${protocol === 'openai' ? '/chat/completions' : '/v1/messages'}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (input.config.apiKey) headers[protocol === 'openai' ? 'authorization' : 'x-api-key'] =
    protocol === 'openai' ? `Bearer ${input.config.apiKey}` : input.config.apiKey;
  const body = protocol === 'openai' ? {
    model: input.config.model,
    messages: [{ role: 'system', content: input.prefix }, ...input.messages],
    max_tokens: input.maxTokens, stream: input.stream,
    ...(input.stream ? { stream_options: { include_usage: true } } : {}),
  } : {
    model: input.config.model,
    system: [{ type: 'text', text: input.prefix, cache_control: { type: 'ephemeral' } }],
    messages: input.messages, max_tokens: input.maxTokens, stream: input.stream,
  };
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: input.signal, redirect: 'error',
    });
  } catch { throw failure('scribe/unavailable', '接口暂时连不上，稍后再试。'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) {
      throw failure('scribe/auth-failed', '密钥不对，请检查配置。');
    }
    const retry = response.headers.get('retry-after');
    const seconds = retry !== null && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : NaN;
    const retryAfterMs = retry === null ? undefined
      : Number.isFinite(seconds) ? seconds : Math.max(0, Date.parse(retry) - clock.now());
    throw Object.assign(failure('scribe/unavailable', `接口请求失败（HTTP ${response.status}）。`), {
      retryable: response.status === 429 || response.status >= 500,
      ...(retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
    });
  }
  try {
    if (!input.stream) {
      const data = record(await response.json());
      const reported = usage(data.usage, protocol);
      let text: string;
      if (protocol === 'openai') {
        const choices = data.choices;
        if (!Array.isArray(choices) || !choices.length) throw failure('scribe/unusable-reply', '接口没有返回文本。');
        const content = record(record(choices[0]).message).content;
        if (typeof content !== 'string') throw failure('scribe/unusable-reply', '接口没有返回文本。');
        text = content;
      } else {
        if (!Array.isArray(data.content)) throw failure('scribe/unusable-reply', '接口没有返回文本。');
        text = data.content.map(block => record(block)).filter(block => block.type === 'text')
          .map(block => typeof block.text === 'string' ? block.text : '').join('');
      }
      return { text, ...(reported ? { usage: reported } : {}) };
    }
    if (!response.body) throw failure('scribe/unavailable', '接口中断了回复。');
    let text = '';
    let reported: ModelReply['usage'];
    let inputUsage: Record<string, unknown> | undefined;
    let finished = false;
    for await (const event of events(response.body)) {
      if (protocol === 'openai' && event === '[DONE]') { finished = true; break; }
      const data = decode(event);
      let delta: unknown;
      if (protocol === 'openai') {
        if (data.error) throw failure('scribe/unavailable', '接口中断了回复。');
        if (data.usage) reported = usage(data.usage, protocol);
        if (Array.isArray(data.choices) && data.choices.length) delta = record(record(data.choices[0]).delta).content;
      } else {
        if (data.type === 'error') throw failure('scribe/unavailable', '接口中断了回复。');
        if (data.type === 'message_start') {
          inputUsage = record(record(data.message).usage);
          reported = usage(inputUsage, protocol);
        }
        if (data.type === 'message_delta' && data.usage) {
          reported = usage({ ...inputUsage, ...record(data.usage) }, protocol);
        }
        if (data.type === 'content_block_start') {
          const block = record(data.content_block);
          if (block.type === 'text') delta = block.text;
        }
        if (data.type === 'content_block_delta') {
          const block = record(data.delta);
          if (block.type === 'text_delta') delta = block.text;
        }
        if (data.type === 'message_stop') { finished = true; break; }
      }
      if (typeof delta === 'string') { text += delta; input.onText?.(delta); }
    }
    if (!finished) throw failure('scribe/unavailable', '接口中断了回复。');
    return { text, ...(reported ? { usage: reported } : {}) };
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause) throw cause;
    throw failure('scribe/unavailable', '接口中断了回复。');
  }
}
export function openAIClient(clock: Clock, fetcher: typeof fetch = fetch): ModelClient {
  return input => send(input, clock, fetcher, 'openai');
}
export function anthropicClient(clock: Clock, fetcher: typeof fetch = fetch): ModelClient {
  return input => send(input, clock, fetcher, 'anthropic');
}
