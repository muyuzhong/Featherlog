import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '@featherlog/kernel';
import type { Envelope, Logger, PluginStorage } from '@featherlog/contracts';
import { createBusBridge, validEnvelope } from './bridge';

class Peer extends EventEmitter {
  constructor(readonly id: number) { super(); }
  destroyed = false;
  send = vi.fn();
  isDestroyed() { return this.destroyed; }
}
const envelope = (kind: 'request' | 'event', id = crypto.randomUUID()): Envelope => ({
  v: 1, kind, id, type: 'shell/state', source: 'shell', time: 1, payload: {},
});
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function fixture(development = true) {
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const timers = new Set<() => void>();
  const timeouts: number[] = [];
  const clock = { now: () => 1, setTimeout: (callback: () => void, ms: number) => {
    timeouts.push(ms);
    timers.add(callback);
    return () => { timers.delete(callback); };
  } };
  const storage: PluginStorage = {
    get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [],
  };
  const kernel = createKernel({ development, clock, log, createServices: () => ({ clock, log,
    storage, settings: { get: () => undefined, onChange: () => () => {} },
    secrets: { get: async () => undefined, onChange: () => () => {} } }) });
  const bus = kernel.createBus('shell');
  const bridge = createBusBridge(kernel, log, development);
  const a = new Peer(1);
  const b = new Peer(2);
  bridge.register(a);
  bridge.register(b);
  return { bridge, kernel, bus, a, b, log, timers, timeouts };
}

describe('IPC bus bridge', () => {
  it.each([
    [undefined, 5000], [65_000, 65_000], [0.5, 0.5], [120_000, 120_000], [120_001, 120_000],
    [Number.MAX_VALUE, 120_000], [0, 5000], [-1, 5000], [NaN, 5000], [Infinity, 5000],
    [-Infinity, 5000], ['65000', 5000], [null, 5000], [true, 5000], [{}, 5000],
  ])('uses the declared request deadline %j, normalized to %i ms', async (timeoutMs, expected) => {
    const { bridge, bus, a, timers, timeouts } = fixture();
    bus.handle('shell/state', () => new Promise<never>(() => {}));
    bridge.receive(a, 'bus:send', { ...envelope('request'), timeoutMs });
    await tick();
    expect(timeouts).toEqual([expected]);
    for (const timer of timers) timer();
    expect(a.send).toHaveBeenCalledOnce();
    expect(a.send.mock.calls[0]![1]).toMatchObject({ payload: { ok: false, error: { code: 'timeout' } } });
  });
  it('forwards a request deadline without knowing the plugin or extending undeclared model requests', () => {
    const inject = vi.fn();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const bridge = createBusBridge({ inject, observe: () => () => {} }, log, true);
    const peer = new Peer(1);
    bridge.register(peer);
    bridge.receive(peer, 'bus:send', { ...envelope('request'), type: 'another-plugin/slow', timeoutMs: 65_000 });
    expect(inject.mock.calls[0]?.[1]).toEqual({ timeoutMs: 65_000 });
    bridge.receive(peer, 'bus:send', { ...envelope('request'), type: 'scribe/draft-quest' });
    expect(inject.mock.calls[1]?.[1]).toBeUndefined();
    bridge.receive(peer, 'bus:send', { ...envelope('event'), timeoutMs: 65_000 });
    expect(inject.mock.calls[2]?.[1]).toBeUndefined();
    expect(inject.mock.calls[2]?.[0]).not.toHaveProperty('timeoutMs');
    bridge.receive(peer, 'bus:send', { ...envelope('request'), timeoutMs: Infinity, origin: 'quest' });
    expect(inject.mock.calls[3]?.[0]).not.toHaveProperty('timeoutMs');
    expect(inject.mock.calls[3]?.[0]).not.toHaveProperty('origin');
    bridge.dispose();
  });
  it('does not trust an origin supplied by a window', async () => {
    const { bridge, bus, a } = fixture();
    const listener = vi.fn();
    bus.on('shell/view-changed', listener);
    bridge.receive(a, 'bus:send', { ...envelope('event'), type: 'shell/view-changed',
      payload: { view: 'panel' }, origin: 'quest' });
    await tick();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![1]).not.toHaveProperty('origin');
  });
  it('delivers only subscribed events and supports unsubscribe', () => {
    const { bridge, bus, a, b } = fixture();
    bridge.receive(a, 'bus:subscribe', ['shell/view-changed']);
    bus.emit('shell/view-changed', { view: 'panel' });
    expect(a.send).toHaveBeenCalledOnce();
    expect(b.send).not.toHaveBeenCalled();
    bridge.receive(a, 'bus:unsubscribe', ['shell/view-changed']);
    bus.emit('shell/view-changed', { view: 'collapsed' });
    expect(a.send).toHaveBeenCalledOnce();
  });

  it.each([true, false])('allows wildcard only in development=%s', development => {
    const { bridge, bus, a } = fixture(development);
    bridge.receive(a, 'bus:subscribe', ['*']);
    bus.emit('shell/view-changed', { view: 'panel' });
    expect(a.send).toHaveBeenCalledTimes(development ? 1 : 0);
  });

  it.each(['success', 'no-handler', 'timeout'] as const)(
    'returns %s responses only to the originating peer, regardless of subscriptions', async mode => {
      const { bridge, bus, a, b, timers } = fixture();
      if (mode !== 'no-handler') bus.handle('shell/state', () => mode === 'timeout'
        ? new Promise(() => {}) : { view: 'collapsed' as const, badges: {}, panel: {} });
      bridge.receive(b, 'bus:subscribe', ['*']);
      const request = envelope('request');
      bridge.receive(a, 'bus:send', request);
      await tick();
      if (mode === 'timeout') for (const timer of [...timers]) timer();
      expect(a.send).toHaveBeenCalledOnce();
      expect(a.send.mock.calls[0]![1]).toMatchObject({ replyTo: request.id, kind: 'response',
        payload: mode === 'success' ? { ok: true } : { ok: false, error: { code: mode } } });
      expect(b.send).not.toHaveBeenCalled();
    },
  );

  it('preserves injected event source and rejects unknown windows', async () => {
    const { bridge, bus, a } = fixture();
    const handler = vi.fn();
    bus.on('shell/view-changed', handler);
    const event = { ...envelope('event'), type: 'shell/view-changed', source: 'quest',
      payload: { view: 'preview' } };
    bridge.receive(new Peer(3), 'bus:send', event);
    bridge.receive(a, 'bus:send', event);
    await tick();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![1]).toMatchObject({ source: 'quest' });
  });

  it.each(['destroyed', 'reload'] as const)('cleans subscriptions and pending routes on %s', async mode => {
    const { bridge, bus, a, b, timers } = fixture();
    bus.handle('shell/state', () => new Promise(() => {}));
    bridge.receive(a, 'bus:subscribe', ['shell/view-changed']);
    const request = envelope('request');
    bridge.receive(a, 'bus:send', request);
    if (mode === 'destroyed') a.emit('destroyed');
    else a.emit('did-start-navigation', {}, 'file:///app', false, true);
    // A late response cannot be redirected by reusing an outstanding id after reload.
    bridge.receive(b, 'bus:send', request);
    bus.emit('shell/view-changed', { view: 'panel' });
    await tick();
    for (const timer of [...timers]) timer();
    expect(a.send).not.toHaveBeenCalled();
    expect(b.send).not.toHaveBeenCalled();
  });

  it('keeps subscriptions through subframe and same-document navigation', () => {
    const { bridge, bus, a } = fixture();
    bridge.receive(a, 'bus:subscribe', ['shell/view-changed']);
    a.emit('did-start-navigation', {}, 'file:///child', false, false);
    a.emit('did-start-navigation', {}, 'file:///app#tab', true, true);
    bus.emit('shell/view-changed', { view: 'panel' });
    expect(a.send).toHaveBeenCalledOnce();
    bridge.dispose();
    expect(a.listenerCount('destroyed')).toBe(0);
    bus.emit('shell/view-changed', { view: 'panel' });
    expect(a.send).toHaveBeenCalledOnce();
  });

  it.each([null, {}, { kind: 'response' }, { v: 2 }, { id: '' }, { source: ' ' },
    { type: 'bad' }, { time: NaN }, { payload: undefined }, { payload: new Date() },
    { replyTo: 'a' }, { causedBy: 1 }])('rejects malformed envelope %j', override => {
    const { bridge, a, log } = fixture();
    const message = override === null ? null : { ...envelope('request'), ...override };
    // {} without overrides is tested separately as an incomplete object.
    const invalid = override && !Object.keys(override).length ? {} : message;
    expect(validEnvelope(invalid)).toBe(false);
    bridge.receive(a, 'bus:send', invalid);
    expect(log.warn).toHaveBeenCalled();
    expect(a.send).not.toHaveBeenCalled();
  });
});
