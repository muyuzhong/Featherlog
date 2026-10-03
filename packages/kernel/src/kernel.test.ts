import { describe, expect, it, vi } from 'vitest';
import type { Bus, Clock, Envelope, Json, MainContext, PluginStorage } from '@featherlog/contracts';
import { createKernel } from './kernel';
import type { Kernel, KernelOptions } from './index';

// Unknown payloads deliberately exercise the runtime boundary, including invalid JSON.
declare module '@featherlog/contracts' {
  interface EventMap { 'alpha/changed': unknown; 'beta/changed': unknown }
  interface RequestMap {
    'alpha/get': { req: unknown; res: unknown };
    'beta/get': { req: unknown; res: unknown };
  }
}

function fixture(development = true, setupTimeoutMs?: number) {
  let time = 1000;
  const timers = new Map<() => void, number>();
  const clock: Clock = {
    now: () => time,
    setTimeout(callback, ms) { timers.set(callback, time + ms); return () => { timers.delete(callback); }; },
  };
  const advance = (ms: number) => {
    time += ms;
    for (const [callback, due] of [...timers]) {
      if (due <= time && timers.delete(callback)) callback();
    }
  };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const settingsDispose = vi.fn();
  const secretsDispose = vi.fn();
  const services = new Map<string, ReturnType<typeof createServices>>();
  function createServices(id: string) {
    const values = new Map<string, Json>();
    const storage: PluginStorage = {
      async get<T extends Json>(key: string) { return values.get(key) as T | undefined; },
      async set(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); },
      async keys() { return [...values.keys()]; },
    };
    const result = { storage, clock, log, settings: { get: () => undefined, onChange: () => settingsDispose },
      secrets: { get: vi.fn(async (key: string) => key === 'token' ? `${id}-secret` : undefined),
        onChange: vi.fn((_listener: (key: string) => void) => secretsDispose) } };
    services.set(id, result);
    return result;
  }
  const options: KernelOptions = { development, setupTimeoutMs, clock, log, createServices };
  const kernel: Kernel = createKernel(options);
  const bus = kernel.createBus('shell');
  const messages: Envelope[] = [];
  kernel.observe(message => messages.push(message));
  return { kernel, bus, messages, clock, log, services, timers, advance, settingsDispose, secretsDispose };
}

it('exposes only the injected plugin secrets and cleans key-only listeners without bus traffic', async () => {
  const { kernel, services, messages, secretsDispose, log } = fixture();
  let alpha!: MainContext;
  let beta!: MainContext;
  const listener = vi.fn();
  await kernel.load([plugin('alpha', ctx => { alpha = ctx; }), plugin('beta', ctx => { beta = ctx; })]);
  messages.length = 0;
  await expect(alpha.secrets.get('token')).resolves.toBe('alpha-secret');
  await expect(beta.secrets.get('token')).resolves.toBe('beta-secret');
  await expect(alpha.secrets.get('missing')).resolves.toBeUndefined();
  const off = alpha.secrets.onChange(listener);
  const callback = services.get('alpha')!.secrets.onChange.mock.calls[0]![0];
  callback('token');
  expect(listener.mock.calls).toEqual([['token']]);
  expect(messages).toEqual([]);
  off(); off();
  expect(secretsDispose).toHaveBeenCalledOnce();
  const broken = vi.fn(() => { throw new Error('listener'); });
  alpha.secrets.onChange(broken);
  const late = services.get('alpha')!.secrets.onChange.mock.calls[1]![0];
  late('token');
  expect(log.error).toHaveBeenCalledOnce();
  kernel.unload('alpha');
  expect(secretsDispose).toHaveBeenCalledTimes(2);
  late('token');
  expect(broken).toHaveBeenCalledOnce();
  await expect(alpha.secrets.get('token')).rejects.toMatchObject({ code: 'disposed' });
  expect(() => alpha.secrets.onChange(listener)).toThrow(expect.objectContaining({ code: 'disposed' }));
  expect(services.get('alpha')!.secrets.get).toHaveBeenCalledTimes(2);
});

it('does not return a late secret after unloading the plugin', async () => {
  const { kernel, services } = fixture();
  let context!: MainContext;
  await kernel.load([plugin('alpha', ctx => { context = ctx; })]);
  let resolve!: (value: string) => void;
  services.get('alpha')!.secrets.get.mockReturnValueOnce(new Promise<string>(done => { resolve = done; }));
  const reading = context.secrets.get('token');
  const rejected = expect(reading).rejects.toMatchObject({ code: 'disposed' });
  kernel.unload('alpha');
  resolve('private-key');
  await rejected;
});

it('cleans secret subscriptions when plugin setup fails', async () => {
  const { kernel, services, secretsDispose } = fixture();
  const listener = vi.fn();
  await kernel.load([plugin('alpha', ctx => {
    ctx.secrets.onChange(listener);
    throw new Error('setup failed');
  })]);
  expect(secretsDispose).toHaveBeenCalledOnce();
  services.get('alpha')!.secrets.onChange.mock.calls[0]![0]('token');
  expect(listener).not.toHaveBeenCalled();
});

const plugin = (id: string, setup: (ctx: MainContext) => void | Promise<void>) => ({
  manifest: { id, name: id, version: '1.2.3' }, setup,
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const incoming = (kind: Envelope['kind'], type = 'alpha/get', payload: unknown = null): Envelope => ({
  v: 1, kind, type, payload, id: crypto.randomUUID(), source: 'external:window', time: 42, causedBy: 'cause',
});

it.each([false, true])('keeps no-handler errors distinct and clone checks intact without observers (dev=%s)', async development => {
  const { clock, log } = fixture();
  const kernel = createKernel({ development, clock, log,
    createServices: () => { throw new Error('unused'); } });
  const bus = kernel.createBus('shell');
  const now = vi.spyOn(clock, 'now');
  const first = await bus.request('alpha/get', null).catch((cause: unknown) => cause);
  const second = await bus.request('alpha/get', null).catch((cause: unknown) => cause);
  expect(first).toBeInstanceOf(Error);
  expect(first).toMatchObject({ code: 'no-handler', stack: expect.stringContaining('kernel.test') });
  expect(first).not.toBe(second);
  expect(now).not.toHaveBeenCalled();
  expect(() => bus.request('alpha/get', () => {}))
    .toThrow(expect.objectContaining({ code: 'not-json' }));
  const seen: Envelope[] = [];
  const off = kernel.observe(message => seen.push(message));
  await expect(bus.request('alpha/get', null)).rejects.toMatchObject({ code: 'no-handler' });
  expect(seen.map(message => message.kind)).toEqual(['request', 'response']);
  off();
  bus.handle('alpha/get', () => 42);
  expect(await bus.request('alpha/get', null)).toBe(42);
});

describe('§4.3 events', () => {
  it('skips unobserved event snapshots but retains development JSON validation', async () => {
    const { clock, log } = fixture();
    const kernel = createKernel({ development: true, clock, log,
      createServices: () => { throw new Error('unused'); } });
    const bus = kernel.createBus('shell');
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      bus.emit('alpha/changed', { value: 1 });
      expect(clone).not.toHaveBeenCalled();
      expect(() => bus.emit('alpha/changed', undefined))
        .toThrow(expect.objectContaining({ code: 'not-json' }));
      const listener = vi.fn();
      bus.on('alpha/changed', listener);
      await flush();
      expect(listener).not.toHaveBeenCalled();
      bus.emit('alpha/changed', { value: 2 });
      await flush();
      expect(listener).toHaveBeenCalledOnce();
      expect(clone).toHaveBeenCalledOnce();
    } finally {
      clone.mockRestore();
    }
  });

  it('reports rejected object and callable thenables from callbacks', async () => {
    const { kernel, bus, log } = fixture();
    const then = (_resolve: unknown, reject: (cause: unknown) => void) => reject(new Error('thenable'));
    kernel.observe(() => ({ then }));
    kernel.observe(() => Object.assign(() => {}, { then }));
    bus.emit('alpha/changed', null);
    await flush();
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it('returns immediately, invokes in send order without awaiting completion, and never replays', async () => {
    const { bus } = fixture();
    const first = deferred();
    const calls: unknown[] = [];
    bus.on('alpha/changed', value => { calls.push(value); return first.promise.then(() => {}); });
    expect(bus.emit('alpha/changed', 1)).toBeUndefined();
    bus.emit('alpha/changed', 2);
    const late = vi.fn();
    bus.on('alpha/changed', late);
    expect(calls).toEqual([]);
    await flush();
    expect(calls).toEqual([1, 2]);
    expect(late).not.toHaveBeenCalled();
    first.resolve(null);
  });

  it('isolates synchronous throws and rejected promises and supports idempotent unsubscribe', async () => {
    const { bus, log } = fixture();
    bus.on('alpha/changed', () => { throw new Error('sync'); });
    bus.on('alpha/changed', async () => { throw new Error('async'); });
    const listener = vi.fn();
    const off = bus.on('alpha/changed', listener);
    bus.emit('alpha/changed', null);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(2);
    off(); off();
    bus.emit('alpha/changed', null);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('populates UUID, source, injected time and optional causedBy', async () => {
    const { bus, messages, clock } = fixture();
    bus.emit('alpha/changed', { value: 1 }, { causedBy: 'parent' });
    bus.emit('alpha/changed', null);
    expect(messages[0]).toMatchObject({ v: 1, kind: 'event', source: 'shell', time: clock.now(), causedBy: 'parent' });
    expect(messages[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(messages[1]?.id).not.toBe(messages[0]?.id);
    expect(messages[1]).not.toHaveProperty('causedBy');
  });
});

describe('§4.3 requests', () => {
  it.each([false, true])('does not arm a timer for an immediate result (async=%s)', async asynchronous => {
    const { bus, clock } = fixture();
    const timer = vi.spyOn(clock, 'setTimeout');
    bus.handle('alpha/get', () => asynchronous ? Promise.resolve(1) : 1);
    await expect(bus.request('alpha/get', null)).resolves.toBe(1);
    await flush();
    expect(timer).not.toHaveBeenCalled();
  });

  it('keeps the original deadline when an asynchronous responder takes time to start', async () => {
    const { bus, advance, timers } = fixture();
    bus.handle('alpha/get', () => {
      advance(20);
      return new Promise(() => {});
    });
    const result = expect(bus.request('alpha/get', null, { timeoutMs: 25 }))
      .rejects.toMatchObject({ code: 'timeout' });
    await flush();
    expect([...timers.values()]).toEqual([1025]);
    advance(5);
    await result;
    expect(timers.size).toBe(0);
  });

  it('copies only the request payload for a missing handler and freezes its failure', async () => {
    const { bus, messages } = fixture();
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      await expect(bus.request('alpha/get', null)).rejects.toMatchObject({ code: 'no-handler' });
      expect(clone).toHaveBeenCalledTimes(1);
      const response = messages.find(message => message.kind === 'response')!;
      expect(Object.isFrozen(response.payload)).toBe(true);
      expect(Object.isFrozen((response.payload as { error: unknown }).error)).toBe(true);
    } finally {
      clone.mockRestore();
    }
  });

  it('does not copy payloads for disposed senders and still validates development JSON', async () => {
    const { kernel } = fixture();
    let bus!: Bus;
    await kernel.load([plugin('alpha', ctx => { bus = ctx.bus; })]);
    kernel.unload('alpha');
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      await expect(bus.request('alpha/get', { values: [1, 2] }))
        .rejects.toMatchObject({ code: 'disposed' });
      expect(() => bus.request('alpha/get', undefined))
        .toThrow(expect.objectContaining({ code: 'not-json' }));
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  });

  it('rejects missing handlers immediately as a Promise and looks up at send time', async () => {
    const { bus, timers } = fixture();
    let result!: Promise<unknown>;
    expect(() => { result = bus.request('alpha/get', null); }).not.toThrow();
    bus.handle('alpha/get', () => 1);
    await expect(result).rejects.toMatchObject({ code: 'no-handler' });
    expect(timers.size).toBe(0);
    await expect(bus.request('alpha/get', null)).resolves.toBe(1);
  });

  it.each([undefined, 25])('times out at %s ms (default 5000), discards late success and releases timer', async timeoutMs => {
    const { bus, advance, timers, messages } = fixture();
    const work = deferred();
    bus.handle('alpha/get', () => work.promise);
    const result = bus.request('alpha/get', null, { timeoutMs });
    const rejected = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await flush();
    advance((timeoutMs ?? 5000) - 1);
    expect(messages.filter(m => m.kind === 'response')).toHaveLength(0);
    advance(1);
    await rejected;
    work.resolve('late');
    await flush();
    expect(messages.filter(m => m.kind === 'response')).toHaveLength(1);
    expect(timers.size).toBe(0);
  });

  it('discards late rejection without unhandled errors', async () => {
    const { bus, advance, messages } = fixture();
    const work = deferred();
    bus.handle('alpha/get', () => work.promise);
    const result = expect(bus.request('alpha/get', null)).rejects.toMatchObject({ code: 'timeout' });
    await flush();
    advance(5000);
    await result;
    work.reject(new Error('late'));
    await flush();
    expect(messages.filter(m => m.kind === 'response')).toHaveLength(1);
  });

  it.each([false, true])('forwards coded Error code/message/data (async=%s)', async asynchronous => {
    const { bus } = fixture();
    const cause = Object.assign(new Error('invalid'), { code: 'alpha/invalid', data: { key: ['x'] } });
    bus.handle('alpha/get', () => { if (asynchronous) return Promise.reject(cause); throw cause; });
    await expect(bus.request('alpha/get', null)).rejects.toMatchObject(cause);
  });

  it.each([new Error('oops'), 'oops', { code: 'alpha/fake', message: 'oops' }, Object.assign(new Error('oops'), { code: 1 })])('normalizes other errors: %s', async cause => {
    const { bus } = fixture();
    bus.handle('alpha/get', () => { throw cause; });
    await expect(bus.request('alpha/get', null)).rejects.toMatchObject({ code: 'handler-error' });
  });

  it('throws duplicate registration synchronously, keeps first handler and permits replacement after dispose', async () => {
    const { bus, timers } = fixture();
    const off = bus.handle('alpha/get', () => null);
    expect(() => bus.handle('alpha/get', () => 2)).toThrow(expect.objectContaining({ code: 'duplicate-handler' }));
    await expect(bus.request('alpha/get', null)).resolves.toBeNull();
    expect(timers.size).toBe(0);
    off(); off();
    bus.handle('alpha/get', () => 2);
    off();
    await expect(bus.request('alpha/get', null)).resolves.toBe(2);
  });
});

const cycle: Record<string, unknown> = {}; cycle.self = cycle;
class Example { value = 1; }
class ExampleArray extends Array {}
const invalid = [undefined, () => {}, new Date(), new Map(), new Example(), new ExampleArray(), cycle, NaN, Infinity, 1n, Symbol('x'), { x: undefined }, [undefined], Array(1), { [Symbol('x')]: 1 }, Object.defineProperty({}, 'x', { value: 1 }), { get x() { return 1; } }, Object.assign([], { x: 1 })];
invalid.push(Object.assign(Array(1), { '01': 1 }), Object.assign(Array(1), { [Symbol('index')]: 1 }));
describe('§4.3 pure JSON', () => {
  it.each(invalid.map((value, index) => [index, value] as const))('rejects invalid payload %i synchronously for emit/request/inject', (_, value) => {
    const { bus, kernel } = fixture();
    for (const send of [() => bus.emit('alpha/changed', value), () => bus.request('alpha/get', value), () => kernel.inject({ ...incoming('event', 'alpha/changed'), payload: value })]) {
      expect(send).toThrow(expect.objectContaining({ code: 'not-json' }));
    }
  });
  it.each(invalid.map((value, index) => [index, value] as const))('rejects invalid response %i', async (_, value) => {
    const { bus } = fixture();
    bus.handle('alpha/get', () => value);
    await expect(bus.request('alpha/get', null)).rejects.toMatchObject({ code: 'not-json' });
  });
  it('allows nested JSON, null-prototype objects and shared non-cyclic references', async () => {
    const { bus } = fixture();
    const child = { value: [null, true, 'text', 1.5] };
    const value = { a: child, b: child, c: Object.create(null) as object };
    bus.handle('alpha/get', payload => payload);
    await expect(bus.request('alpha/get', value)).resolves.toEqual(value);
  });
  it('validates forwarded error data', async () => {
    const { bus } = fixture();
    bus.handle('alpha/get', () => { throw Object.assign(new Error('bad'), { code: 'alpha/bad', data: new Date() }); });
    await expect(bus.request('alpha/get', null)).rejects.toMatchObject({ code: 'not-json' });
  });
  it('skips payload and response validation in production', async () => {
    const { bus } = fixture(false);
    bus.emit('alpha/changed', cycle);
    bus.handle('alpha/get', payload => payload);
    await expect(bus.request('alpha/get', cycle)).resolves.toEqual(cycle);
  });
});

describe('§4.5 host API', () => {
  it('observes every event/request/response, supports disposal and isolates observer errors', async () => {
    const { kernel, bus, messages, log } = fixture();
    const off = kernel.observe(() => { throw new Error('observer'); });
    bus.handle('alpha/get', () => 123);
    bus.emit('alpha/changed', null);
    await bus.request('alpha/get', null, { causedBy: 'cause' });
    expect(messages.map(m => m.kind)).toEqual(['event', 'request', 'response']);
    expect(messages[1]).toMatchObject({ causedBy: 'cause' });
    expect(messages[2]).toMatchObject({ type: 'alpha/get', replyTo: messages[1]?.id, source: 'shell', payload: { ok: true, data: 123 } });
    expect(log.error).toHaveBeenCalledTimes(3);
    off(); off();
    bus.emit('alpha/changed', null);
    expect(log.error).toHaveBeenCalledTimes(3);
  });
  it('preserves injected envelopes and delivers external events', async () => {
    const { kernel, bus, messages } = fixture();
    const listener = vi.fn();
    bus.on('alpha/changed', listener);
    const message = incoming('event', 'alpha/changed', { x: 1 });
    expect(kernel.inject(message)).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    await flush();
    expect(listener).toHaveBeenCalledWith(message.payload, message);
    expect(messages).toEqual([message]);
    const response = incoming('response');
    kernel.inject(response);
    expect(messages[1]).toEqual(response);
  });
  it.each(['success', 'no-handler', 'timeout', 'handler-error'] as const)('observes injected request and %s response', async mode => {
    const { kernel, bus, messages, advance } = fixture();
    if (mode !== 'no-handler') bus.handle('alpha/get', (_, message) => {
      expect(message.source).toBe('external:window');
      if (mode === 'timeout') return new Promise(() => {});
      if (mode === 'handler-error') throw new Error('broken');
      return null;
    });
    const request = incoming('request');
    kernel.inject(request);
    await flush();
    if (mode === 'timeout') advance(5000);
    await flush();
    expect(messages[0]).toEqual(request);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ kind: 'response', type: request.type, replyTo: request.id, payload: mode === 'success' ? { ok: true, data: null } : { ok: false, error: { code: mode } } });
  });
});

describe('§5.3–5.4 lifecycle and §4.2 namespaces', () => {
  it('sets up sequentially after host handlers, builds scoped contexts and emits loaded then ready', async () => {
    const { kernel, bus, messages, services } = fixture();
    const order: string[] = [];
    const gate = deferred();
    const entered = deferred();
    let alpha!: MainContext;
    bus.handle('beta/get', () => 7);
    const loading = kernel.load([
      plugin('alpha', async ctx => {
        alpha = ctx;
        expect(ctx.pluginId).toBe('alpha');
        expect(ctx.storage).toBe(services.get('alpha')?.storage);
        expect(ctx.log).toBe(services.get('alpha')?.log);
        expect(ctx.clock.now()).toBe(1000);
        expect(ctx.settings.get('x')).toBeUndefined();
        expect(ctx.bus).not.toHaveProperty('observe');
        expect(ctx.bus).not.toHaveProperty('inject');
        await expect(ctx.bus.request('beta/get', null)).resolves.toBe(7);
        ctx.bus.on('kernel/ready', () => { order.push('ready'); });
        order.push('alpha');
        entered.resolve(null);
        await gate.promise;
      }),
      plugin('beta', () => { order.push('beta'); }),
    ]);
    await entered.promise;
    expect(order).toEqual(['alpha']);
    gate.resolve(null);
    await loading;
    await flush();
    expect(order).toEqual(['alpha', 'beta', 'ready']);
    expect(messages.filter(m => m.type.startsWith('kernel/')).map(m => [m.type, m.payload])).toEqual([
      ['kernel/plugin-loaded', { pluginId: 'alpha', version: '1.2.3' }],
      ['kernel/plugin-loaded', { pluginId: 'beta', version: '1.2.3' }],
      ['kernel/ready', { pluginIds: ['alpha', 'beta'] }],
    ]);
    alpha.bus.emit('alpha/changed', null);
    expect(messages.at(-1)?.source).toBe('alpha');
  });

  it.each([false, true])('isolates setup failure (async=%s), cleans registrations and keeps loading', async asynchronous => {
    const { kernel, bus, messages, timers, advance } = fixture();
    const listener = vi.fn();
    const cleanup = vi.fn();
    await kernel.load([
      plugin('alpha', ctx => {
        ctx.bus.on('beta/changed', listener);
        ctx.bus.handle('alpha/get', () => null);
        ctx.clock.setTimeout(listener, 1);
        ctx.onDispose(cleanup);
        const cause = Object.assign(new Error('setup failed'), { code: 'alpha/setup', data: { step: 1 } });
        if (asynchronous) return Promise.reject(cause);
        throw cause;
      }),
      plugin('beta', ctx => { ctx.bus.handle('beta/get', () => 2); }),
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(timers.size).toBe(0);
    advance(2);
    bus.emit('beta/changed', null);
    await flush();
    expect(listener).not.toHaveBeenCalled();
    await expect(bus.request('alpha/get', null)).rejects.toMatchObject({ code: 'no-handler' });
    await expect(bus.request('beta/get', null)).resolves.toBe(2);
    expect(messages.filter(m => m.type.startsWith('kernel/')).map(m => m.type)).toEqual(['kernel/plugin-failed', 'kernel/plugin-loaded', 'kernel/ready']);
    expect(messages.find(m => m.type === 'kernel/plugin-failed')?.payload).toEqual({ pluginId: 'alpha', error: { code: 'alpha/setup', message: 'setup failed', data: { step: 1 } } });
    expect(messages.find(m => m.type === 'kernel/ready')?.payload).toEqual({ pluginIds: ['beta'] });
  });

  it('cleans all resources in reverse registration order despite errors, cancels queued listeners and prevents reuse', async () => {
    const { kernel, bus, messages, timers, advance, settingsDispose, secretsDispose, log } = fixture();
    const order: number[] = [];
    const listener = vi.fn();
    let context!: MainContext;
    await kernel.load([plugin('alpha', ctx => {
      context = ctx;
      ctx.onDispose(() => { order.push(1); });
      ctx.bus.on('beta/changed', listener);
      ctx.bus.handle('alpha/get', () => 1);
      ctx.clock.setTimeout(listener, 5);
      ctx.settings.onChange(listener);
      ctx.secrets.onChange(listener);
      ctx.onDispose(() => { order.push(2); throw new Error('cleanup failed'); });
      ctx.onDispose(() => { order.push(3); });
    })]);
    bus.emit('beta/changed', null);
    kernel.unload('alpha'); kernel.unload('alpha');
    advance(10);
    await flush();
    expect(order).toEqual([3, 2, 1]);
    expect(log.error).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    expect(settingsDispose).toHaveBeenCalledOnce();
    expect(secretsDispose).toHaveBeenCalledOnce();
    expect(timers.size).toBe(0);
    expect(messages.filter(m => m.type === 'kernel/plugin-unloaded')).toHaveLength(1);
    await expect(bus.request('alpha/get', null)).rejects.toMatchObject({ code: 'no-handler' });
    await expect(context.bus.request('beta/get', null)).rejects.toMatchObject({ code: 'disposed' });
    for (const register of [() => context.bus.on('alpha/changed', listener), () => context.bus.handle('alpha/get', () => null), () => context.bus.emit('alpha/changed', null), () => context.clock.setTimeout(listener, 1), () => context.settings.onChange(listener), () => context.onDispose(listener)]) {
      expect(register).toThrow(expect.objectContaining({ code: 'disposed' }));
    }
    await kernel.load([plugin('alpha', ctx => { ctx.bus.handle('alpha/get', () => 2); })]);
    await expect(bus.request('alpha/get', null)).resolves.toBe(2);
  });


  it('interleaves timer, settings and callback cleanup in reverse registration order', async () => {
    const { kernel, clock, settingsDispose } = fixture();
    const order: string[] = [];
    const originalTimer = clock.setTimeout;
    vi.spyOn(clock, 'setTimeout').mockImplementation((callback, ms) => {
      const cancel = originalTimer(callback, ms);
      return () => { order.push('timer'); cancel(); };
    });
    settingsDispose.mockImplementation(() => { order.push('settings'); });
    await kernel.load([plugin('alpha', ctx => {
      ctx.onDispose(() => { order.push('first'); });
      ctx.clock.setTimeout(() => {}, 100);
      ctx.settings.onChange(() => {});
      ctx.onDispose(() => { order.push('last'); });
    })]);
    kernel.unload('alpha');
    expect(order).toEqual(['timer', 'last', 'settings', 'timer', 'first']);
  });


  it('does not invoke disposed responders from inside cleanup callbacks', async () => {
    const { kernel, bus, timers } = fixture();
    const handler = vi.fn(() => new Promise(() => {}));
    let result!: Promise<unknown>;
    await kernel.load([plugin('alpha', ctx => {
      ctx.bus.handle('alpha/get', handler);
      ctx.onDispose(() => { result = bus.request('alpha/get', null); void result.catch(() => {}); });
    })]);
    kernel.unload('alpha');
    await expect(result).rejects.toMatchObject({ code: 'disposed' });
    expect(handler).not.toHaveBeenCalled();
    expect(timers.size).toBe(0);
  });

  it('emits ready even for an empty batch', async () => {
    const { kernel, messages } = fixture();
    await kernel.load([]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'kernel/ready', source: 'kernel', payload: { pluginIds: [] } });
  });

  it('releases canceled/fired timers and manually removed subscriptions only once', async () => {
    const { kernel, bus, advance, timers } = fixture();
    const callback = vi.fn();
    await kernel.load([plugin('alpha', ctx => {
      const off = ctx.bus.on('beta/changed', callback); off(); off();
      const cancel = ctx.clock.setTimeout(callback, 1); cancel(); cancel();
      ctx.clock.setTimeout(callback, 2);
    })]);
    advance(2);
    expect(callback).toHaveBeenCalledOnce();
    expect(timers.size).toBe(0);
    bus.emit('beta/changed', null);
    kernel.unload('alpha');
    await flush();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('rejects unfinished inbound, outbound and injected requests on unload, ignores late replies', async () => {
    const { kernel, bus, messages, timers } = fixture();
    const work = deferred();
    let outbound!: Promise<unknown>;
    bus.handle('beta/get', () => work.promise);
    await kernel.load([plugin('alpha', ctx => {
      ctx.bus.handle('alpha/get', () => work.promise);
      outbound = ctx.bus.request('beta/get', null);
    })]);
    const inbound = bus.request('alpha/get', null);
    const external = incoming('request');
    kernel.inject(external);
    const checks = [expect(inbound).rejects.toMatchObject({ code: 'disposed' }), expect(outbound).rejects.toMatchObject({ code: 'disposed' })];
    kernel.unload('alpha');
    await Promise.all(checks);
    expect(messages.find(m => m.replyTo === external.id)?.payload).toMatchObject({ ok: false, error: { code: 'disposed' } });
    work.resolve(1);
    await flush();
    expect(messages.filter(m => m.kind === 'response')).toHaveLength(3);
    expect(timers.size).toBe(0);
  });

  it('cleans pending requests on setup failure and permits requests to other plugins after ready', async () => {
    const { kernel, bus } = fixture();
    let failedRequest!: Promise<unknown>;
    let readyRequest!: Promise<unknown>;
    bus.handle('beta/get', () => new Promise(() => {}));
    await kernel.load([
      plugin('broken', ctx => {
        failedRequest = ctx.bus.request('beta/get', null);
        void failedRequest.catch(() => {});
        throw new Error('setup');
      }),
      plugin('gamma', ctx => { ctx.bus.on('kernel/ready', () => { readyRequest = ctx.bus.request('alpha/get', null); }); }),
      plugin('alpha', ctx => { ctx.bus.handle('alpha/get', () => 9); }),
    ]);
    await flush();
    await expect(failedRequest).rejects.toMatchObject({ code: 'disposed' });
    await expect(readyRequest).resolves.toBe(9);
  });

  it('handles unload during async setup without resurrecting plugin', async () => {
    const { kernel, messages } = fixture();
    const gate = deferred();
    const loading = kernel.load([plugin('alpha', async () => { await gate.promise; })]);
    kernel.unload('alpha');
    gate.resolve(null);
    await loading;
    expect(messages.some(m => m.type === 'kernel/plugin-loaded')).toBe(false);
    expect(messages.at(-1)?.payload).toEqual({ pluginIds: [] });
  });

  it.each([true, false])('checks plugin event/handler namespaces only in development=%s', async development => {
    const { kernel, bus } = fixture(development);
    let pluginBus!: Bus;
    await kernel.load([plugin('alpha', ctx => { pluginBus = ctx.bus; })]);
    for (const action of [() => pluginBus.emit('beta/changed', null), () => pluginBus.emit('kernel/ready', { pluginIds: [] }), () => pluginBus.handle('beta/get', () => null)]) {
      if (development) expect(action).toThrow(expect.objectContaining({ code: 'forbidden-namespace' }));
      else expect(action).not.toThrow();
    }
    expect(() => pluginBus.emit('alpha/changed', null)).not.toThrow();
    expect(() => pluginBus.handle('alpha/get', () => null)).not.toThrow();
    if (development) bus.handle('beta/get', () => 1);
    await expect(pluginBus.request('beta/get', null)).resolves.toBe(development ? 1 : null);
  });
});

describe.each([true, false])('§4.3 immutable snapshots (development=%s)', development => {
  type Data = { nested: { value: number }; items: number[] };
  const data = (): Data => ({ nested: { value: 1 }, items: [1] });

  it('copies sent events once and prevents listeners and observers affecting each other', async () => {
    const { kernel, bus, messages, log } = fixture(development);
    const original = data();
    let first!: Data;
    let second!: Data;
    kernel.observe(message => {
      (message.payload as Data).nested.value = 8;
    });
    bus.on('alpha/changed', payload => {
      first = payload as Data;
      first.items.push(9);
    });
    bus.on('alpha/changed', payload => { second = payload as Data; });
    bus.emit('alpha/changed', original);
    original.nested.value = 2;
    original.items.push(2);
    await flush();
    expect(first).toEqual(data());
    expect(second).toBe(first);
    expect(messages[0]?.payload).toBe(first);
    expect(first).not.toBe(original);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.nested)).toBe(true);
    expect(Object.isFrozen(first.items)).toBe(true);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it('protects responder state from the requester and snapshots before later changes', async () => {
    const { bus, messages } = fixture(development);
    const state = data();
    bus.handle('alpha/get', () => {
      queueMicrotask(() => { state.nested.value = 2; });
      return state;
    });
    const pending = bus.request('alpha/get', null);
    const received = await pending as Data;
    expect(received).toEqual(data());
    expect(() => { received.nested.value = 3; }).toThrow(TypeError);
    expect(() => { received.items.push(3); }).toThrow(TypeError);
    expect(state).toEqual({ nested: { value: 2 }, items: [1] });
    const payload = messages.at(-1)?.payload as { ok: true; data: Data };
    expect(payload.data).toBe(received);
    expect(Object.isFrozen(payload)).toBe(true);
  });

  it('also copies and freezes asynchronous response data', async () => {
    const { bus } = fixture(development);
    const state = data();
    bus.handle('alpha/get', async () => state);
    const received = await bus.request('alpha/get', null) as Data;
    expect(received).not.toBe(state);
    expect(() => { received.nested.value = 5; }).toThrow(TypeError);
    expect(state).toEqual(data());
  });

  it('copies request input and freezes the copy seen by the responder', async () => {
    const { bus, messages } = fixture(development);
    const original = data();
    const gate = deferred();
    let received!: Data;
    bus.handle('alpha/get', async payload => {
      received = payload as Data;
      await gate.promise;
      return received;
    });
    const result = bus.request('alpha/get', original);
    original.nested.value = 2;
    await Promise.resolve();
    expect(received).toEqual(data());
    expect(messages[0]?.payload).toBe(received);
    expect(() => { received.nested.value = 3; }).toThrow(TypeError);
    gate.resolve(null);
    await expect(result).resolves.toEqual(data());
  });

  it.each(['event', 'request', 'response'] as const)('copies injected %s payloads and metadata', async kind => {
    const { kernel, bus, messages } = fixture(development);
    bus.handle('alpha/get', payload => payload);
    const original = incoming(kind, kind === 'event' ? 'alpha/changed' : 'alpha/get', data());
    kernel.inject(original);
    (original.payload as Data).nested.value = 2;
    original.source = 'changed';
    original.id = 'changed';
    await flush();
    expect(messages[0]?.source).toBe('external:window');
    expect(messages[0]?.id).not.toBe('changed');
    expect(messages[0]?.payload).toEqual(data());
    expect(Object.isFrozen((messages[0]?.payload as Data).nested)).toBe(true);
  });

  it('copies and freezes forwarded error data', async () => {
    const { bus } = fixture(development);
    const state = data();
    bus.handle('alpha/get', () => {
      throw Object.assign(new Error('failed'), { code: 'alpha/failed', data: state });
    });
    const result = bus.request('alpha/get', null);
    const received = await result.catch((cause: unknown) => cause) as Error & { data: Data };
    expect(received.data).not.toBe(state);
    expect(() => { received.data.nested.value = 2; }).toThrow(TypeError);
    expect(state).toEqual(data());
  });

  it('accepts negative zero in payloads and responses', async () => {
    const { bus, messages } = fixture(development);
    bus.emit('alpha/changed', { value: -0 });
    bus.handle('alpha/get', value => value);
    await expect(bus.request('alpha/get', -0)).resolves.toBe(-0);
    expect(messages[0]?.payload).toEqual({ value: -0 });
  });
});

describe('§4.3 handler error boundary', () => {
  it.each(['ENOENT', 'timeout', 'no-handler', 'not-json', 'alpha', '/bad', 'alpha/',
    'alpha/bad/extra', 'Alpha/bad', 'alpha/bad_reason'])('normalizes code %s and preserves message', async code => {
    const { bus } = fixture();
    bus.handle('alpha/get', () => {
      throw Object.assign(new Error('original message'), { code, data: { private: true } });
    });
    const cause = await bus.request('alpha/get', null).catch((value: unknown) => value);
    expect(cause).toMatchObject({ code: 'handler-error', message: 'original message' });
    expect(cause).not.toHaveProperty('data');
  });

  it.each(['timeout', 'no-handler'] as const)('does not expose downstream %s as own failure', async code => {
    const { bus, advance, messages } = fixture();
    if (code === 'timeout') bus.handle('beta/get', () => new Promise(() => {}));
    bus.handle('alpha/get', () => bus.request('beta/get', null, { timeoutMs: 1 }));
    const result = bus.request('alpha/get', null);
    const check = expect(result).rejects.toMatchObject({
      code: 'handler-error',
      message: code === 'timeout' ? 'Request beta/get timed out' : 'No handler for beta/get',
    });
    await flush();
    if (code === 'timeout') advance(1);
    await check;
    expect(messages.filter(message => message.kind === 'response').map(message => {
      return (message.payload as { error: { code: string } }).error.code;
    })).toEqual([code, 'handler-error']);
  });
});

describe('§5.3 batch validation and setup deadlines', () => {
  it.each(['Bad', '', 'bad_name', 'bad/name', 'bad--name', '-bad', 'bad-',
    'kernel', 'shell', 'external', null, undefined, 123])('rejects invalid id %s before any setup', async id => {
    const { kernel, messages, services, timers } = fixture();
    const setup = vi.fn();
    await expect(kernel.load([
      plugin('alpha', setup),
      plugin(id as string, setup),
    ])).rejects.toMatchObject({ code: 'invalid-plugin' });
    expect(setup).not.toHaveBeenCalled();
    expect(services.size).toBe(0);
    expect(timers.size).toBe(0);
    expect(messages).toEqual([]);
  });

  it('rejects duplicate ids within the batch before any setup, including would-be failed plugins', async () => {
    const { kernel } = fixture();
    const setup = vi.fn(() => { throw new Error('would fail'); });
    await expect(kernel.load([
      plugin('alpha', setup), plugin('alpha', setup),
    ])).rejects.toMatchObject({ code: 'invalid-plugin' });
    expect(setup).not.toHaveBeenCalled();
  });

  it('rejects a batch conflicting with loaded plugins without loading its valid prefix', async () => {
    const { kernel, bus } = fixture();
    await kernel.load([plugin('alpha', ctx => { ctx.bus.handle('alpha/get', () => 1); })]);
    const setup = vi.fn();
    await expect(kernel.load([
      plugin('beta', setup), plugin('alpha', setup),
    ])).rejects.toMatchObject({ code: 'invalid-plugin' });
    expect(setup).not.toHaveBeenCalled();
    await expect(bus.request('alpha/get', null)).resolves.toBe(1);
  });

  it.each([undefined, 25])('times out setup at %s ms (default 10000), cleans up and keeps loading', async timeout => {
    const { kernel, bus, advance, messages, timers, settingsDispose, secretsDispose } = fixture(true, timeout);
    const gate = deferred();
    const cleanup = vi.fn();
    const listener = vi.fn();
    const next = vi.fn();
    let context!: MainContext;
    let outbound!: Promise<unknown>;
    bus.handle('beta/get', () => new Promise(() => {}));
    const loading = kernel.load([
      plugin('alpha', async ctx => {
        context = ctx;
        ctx.onDispose(cleanup);
        ctx.bus.on('beta/changed', listener);
        ctx.bus.handle('alpha/get', () => new Promise(() => {}));
        ctx.clock.setTimeout(listener, 20_000);
        ctx.settings.onChange(listener);
        ctx.secrets.onChange(listener);
        outbound = ctx.bus.request('beta/get', null, { timeoutMs: 20_000 });
        void outbound.catch(() => {});
        await gate.promise;
      }),
      plugin('next', next),
    ]);
    const inbound = bus.request('alpha/get', null, { timeoutMs: 20_000 });
    const canceled = expect(inbound).rejects.toMatchObject({ code: 'disposed' });
    advance((timeout ?? 10_000) - 1);
    await flush();
    expect(next).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    advance(1);
    expect(() => context.bus.handle('alpha/get', () => null)).toThrow(
      expect.objectContaining({ code: 'disposed' }),
    );
    await loading;
    await canceled;
    await expect(outbound).rejects.toMatchObject({ code: 'disposed' });
    expect(next).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(settingsDispose).toHaveBeenCalledOnce();
    expect(secretsDispose).toHaveBeenCalledOnce();
    expect(timers.size).toBe(0);
    expect(messages.find(message => message.type === 'kernel/plugin-failed')?.payload).toEqual({
      pluginId: 'alpha', error: { code: 'timeout', message: 'Plugin alpha setup timed out' },
    });
    expect(messages.at(-1)?.payload).toEqual({ pluginIds: ['next'] });
    const count = messages.length;
    gate.resolve(null);
    await flush();
    expect(messages).toHaveLength(count);
    expect(cleanup).toHaveBeenCalledOnce();
    bus.emit('beta/changed', null);
    await flush();
    expect(listener).not.toHaveBeenCalled();
    await expect(bus.request('alpha/get', null)).rejects.toMatchObject({ code: 'no-handler' });
  });

  it('ignores late setup rejection and leaves a reloaded instance alive', async () => {
    const { kernel, bus, advance, messages } = fixture(true, 10);
    const gate = deferred();
    const loading = kernel.load([plugin('alpha', async () => { await gate.promise; })]);
    advance(10);
    await loading;
    await kernel.load([plugin('alpha', ctx => { ctx.bus.handle('alpha/get', () => 2); })]);
    const count = messages.length;
    gate.reject(new Error('late setup error'));
    await flush();
    expect(messages).toHaveLength(count);
    await expect(bus.request('alpha/get', null)).resolves.toBe(2);
  });

  it('cancels setup deadlines after success or immediate failure', async () => {
    const { kernel, timers, advance, messages } = fixture();
    await kernel.load([
      plugin('alpha', () => {}),
      plugin('beta', () => { throw new Error('failed'); }),
    ]);
    expect(timers.size).toBe(0);
    const count = messages.length;
    advance(10_000);
    await flush();
    expect(messages).toHaveLength(count);
  });
});

describe('§4.3 asynchronous responders', () => {
  it('returns before invoking the responder in the next microtask', async () => {
    const { bus } = fixture();
    const handler = vi.fn(() => 1);
    bus.handle('alpha/get', handler);
    const result = bus.request('alpha/get', null);
    expect(handler).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledOnce();
    await expect(result).resolves.toBe(1);
  });

  it('invokes injected request responders in a microtask too', async () => {
    const { kernel, bus, messages } = fixture();
    const handler = vi.fn(() => 1);
    bus.handle('alpha/get', handler);
    const request = incoming('request');
    kernel.inject(request);
    expect(handler).not.toHaveBeenCalled();
    expect(messages.map(message => message.kind)).toEqual(['request']);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledOnce();
    expect(messages.at(-1)).toMatchObject({
      kind: 'response', replyTo: request.id, payload: { ok: true, data: 1 },
    });
  });

  it('retains the responder selected when the request was sent', async () => {
    const { bus } = fixture();
    const first = vi.fn(() => 1);
    const replacement = vi.fn(() => 2);
    const remove = bus.handle('alpha/get', first);
    const result = bus.request('alpha/get', null);
    remove();
    bus.handle('alpha/get', replacement);
    await expect(result).resolves.toBe(1);
    expect(first).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'disposed'] as const)(
    'skips queued responders after %s',
    async code => {
      const { kernel, bus, advance } = fixture();
      const handler = vi.fn(() => 1);
      await kernel.load([plugin('alpha', ctx => {
        ctx.bus.handle('alpha/get', handler);
      })]);
      const result = bus.request('alpha/get', null, { timeoutMs: 1 });
      const rejected = expect(result).rejects.toMatchObject({ code });
      if (code === 'timeout') advance(1);
      else kernel.unload('alpha');
      await rejected;
      expect(handler).not.toHaveBeenCalled();
    },
  );
});
