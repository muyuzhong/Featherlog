import { describe, expect, it, vi } from 'vitest';
import type { Clock } from '@featherlog/contracts';
import { anthropicClient, endpoint, openAIClient } from './model';
import type { ModelRequest } from './model';
import { PERSONA } from './writing';

const clock: Clock = { now: () => Date.parse('2026-10-03T12:00:00Z'), setTimeout: () => () => {} };
function request(stream = false): ModelRequest {
  return { config: { protocol: 'openai', baseUrl: 'https://example.com/api', model: 'my-model', apiKey: 'secret' },
    prefix: PERSONA, messages: [{ role: 'user', content: '你好' }], maxTokens: 100, stream,
    signal: new AbortController().signal };
}
function sse(parts: string[]) {
  const bytes = new TextEncoder().encode(parts.join(''));
  return new Response(new ReadableStream({ start(controller) {
    // Split inside UTF-8 characters as well as SSE delimiters.
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
  } }));
}
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;

describe('host boundary and protocol requests', () => {
  it.each(['http://example.com', 'ftp://localhost', 'https://user:secret@example.com', 'https://example.com?q=1',
    'https://example.com/#x', 'not a URL', 'http://[::1]', 'http://127.0.0.2'])('rejects %s', url => {
    expect(() => endpoint(url)).toThrow(expect.objectContaining({ code: 'scribe/not-configured' }));
  });
  it.each(['http://localhost:11434/v1', 'http://127.0.0.1:3000', 'https://example.com/v1'])('allows %s', url => {
    expect(endpoint(url)).toBeInstanceOf(URL);
  });
  it('sends OpenAI-compatible messages, preserves model and does not follow redirects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content: '记下了。' } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 } }));
    const reply = await openAIClient(clock, fetcher)(request());
    expect(reply).toEqual({ text: '记下了。', usage: { inputTokens: 12, outputTokens: 3 } });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://example.com/api/chat/completions');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer secret' } });
    expect(JSON.parse(String(options!.body))).toEqual({ model: 'my-model', max_tokens: 100, stream: false,
      messages: [{ role: 'system', content: PERSONA }, { role: 'user', content: '你好' }] });
  });
  it('sends Anthropic system prefix with cache_control and ignores non-text blocks', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ content: [{ type: 'thinking', thinking: 'private' },
      { type: 'text', text: '记下了。' }, { type: 'text', text: '接着来。' }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } }));
    const reply = await anthropicClient(clock, fetcher)(request());
    expect(reply).toEqual({ text: '记下了。接着来。', usage: { inputTokens: 60, outputTokens: 5 } });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://example.com/api/v1/messages');
    expect(options!.headers).toMatchObject({ 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' });
    expect(JSON.parse(String(options!.body))).toMatchObject({ system: [{ type: 'text', text: PERSONA,
      cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: '你好' }], max_tokens: 100 });
  });
  it('omits credentials for local models and treats missing/invalid usage as unreported', async () => {
    const input = request(); delete input.config.apiKey; input.config.baseUrl = 'http://localhost:1234/v1/';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content: '好' } }],
      usage: { prompt_tokens: -1, completion_tokens: 1 } }));
    expect(await openAIClient(clock, fetcher)(input)).toEqual({ text: '好' });
    expect(fetcher.mock.calls[0]![1]!.headers).toEqual({ 'content-type': 'application/json' });
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://localhost:1234/v1/chat/completions');
  });
});

describe('streaming text and cumulative usage', () => {
  it('decodes split UTF-8 and CRLF, ignores comments, accepts final usage and DONE', async () => {
    const onText = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sse([': ping\n\n',
      event({ choices: [{ delta: { role: 'assistant' } }] }), event({ choices: [{ delta: { content: '此步' } }] }),
      event({ choices: [{ delta: { content: '已过。' } }] }),
      event({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }), 'data: [DONE]']));
    expect(await openAIClient(clock, fetcher)({ ...request(true), onText })).toEqual({ text: '此步已过。',
      usage: { inputTokens: 10, outputTokens: 4 } });
    expect(onText.mock.calls).toEqual([['此步'], ['已过。']]);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).stream_options).toEqual({ include_usage: true });
  });
  it('merges Anthropic start and cumulative output usage, ignores thinking and unknown events', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sse([
      event({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 10 } } }),
      event({ type: 'ping' }), event({ type: 'future_event' }),
      event({ type: 'content_block_start', content_block: { type: 'text', text: '此步' } }),
      event({ type: 'content_block_start', content_block: { type: 'thinking' } }),
      event({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } }),
      event({ type: 'content_block_delta', delta: { type: 'text_delta', text: '已过。' } }),
      event({ type: 'message_delta', usage: { output_tokens: 3 } }),
      event({ type: 'message_delta', usage: { output_tokens: 6 } }), event({ type: 'message_stop' }),
    ]));
    expect(await anthropicClient(clock, fetcher)(request(true))).toEqual({ text: '此步已过。',
      usage: { inputTokens: 15, outputTokens: 6 } });
  });
  it.each(['openai', 'anthropic'] as const)('rejects truncated %s streams and stream errors', async protocol => {
    const client = protocol === 'openai' ? openAIClient : anthropicClient;
    for (const body of [sse([event({ choices: [{ delta: { content: '未完' } }] })]),
      sse([event({ type: 'error', error: { message: 'contains secret' } })]), sse(['data: nope\n\n'])]) {
      await expect(client(clock, vi.fn<typeof fetch>().mockResolvedValue(body))(request(true))).rejects.toMatchObject({
        code: expect.stringMatching(/^scribe\/(unavailable|unusable-reply)$/),
      });
    }
  });
});

describe('sanitized errors and Retry-After', () => {
  it.each([401, 403, 429, 500, 503, 400])('maps HTTP %i without exposing bodies', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private input/key', { status,
      headers: { 'retry-after': '12' } }));
    await expect(openAIClient(clock, fetcher)(request())).rejects.toMatchObject({
      code: status === 401 || status === 403 ? 'scribe/auth-failed' : 'scribe/unavailable',
      ...(status === 401 || status === 403 ? {} : { retryAfterMs: 12_000, retryable: status === 429 || status >= 500 }),
    });
  });
  it('parses HTTP dates against the injected clock and ignores invalid Retry-After', async () => {
    for (const retry of ['Sat, 03 Oct 2026 12:01:00 GMT', 'invalid']) {
      try { await openAIClient(clock, vi.fn<typeof fetch>().mockResolvedValue(new Response('', {
        status: 429, headers: { 'retry-after': retry },
      })))(request()); } catch (cause) {
        expect(cause).toMatchObject({ code: 'scribe/unavailable' });
        expect((cause as { retryAfterMs?: number }).retryAfterMs).toBe(retry === 'invalid' ? undefined : 60_000);
      }
    }
  });
  it('sanitizes fetch errors and malformed successful replies', async () => {
    await expect(openAIClient(clock, vi.fn<typeof fetch>().mockRejectedValue(new Error('secret')))(request()))
      .rejects.toMatchObject({ code: 'scribe/unavailable', message: '接口暂时连不上，稍后再试。' });
    for (const data of [null, {}, { choices: [] }, { choices: [{ message: { content: null } }] }]) {
      await expect(openAIClient(clock, vi.fn<typeof fetch>().mockResolvedValue(Response.json(data)))(request()))
        .rejects.toMatchObject({ code: 'scribe/unusable-reply' });
    }
    await expect(anthropicClient(clock, vi.fn<typeof fetch>().mockResolvedValue(Response.json({ content: null })))(request()))
      .rejects.toMatchObject({ code: 'scribe/unusable-reply' });
  });
});
