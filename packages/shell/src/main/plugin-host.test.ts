import { expect, it, vi } from 'vitest';
import { createKernel, type MainPlugin } from '@featherlog/kernel';
import type { Clock, Envelope, Json, PluginStorage, RequestPayload } from '@featherlog/contracts';
import { registerPluginHost } from './plugin-host';
import { plugins as builtin } from './plugins';
import { registerShell } from './shell-state';

function fixture(plugins: MainPlugin[], saved: string[] = []) {
  const time = new Date('2026-10-05T12:00:00').getTime();
  const timers = new Set<() => void>();
  const clock: Clock = { now: () => time, setTimeout(callback) { timers.add(callback); return () => { timers.delete(callback); }; } };
  const data = new Map<string, Map<string, Json>>();
  const storages = new Map<string, PluginStorage>();
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const kernel = createKernel({ development: true, clock, log, createServices(id) {
    const values = data.get(id) ?? new Map<string, Json>(); data.set(id, values);
    const storage: PluginStorage = {
      async get<T extends Json>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
      set: vi.fn(async (key, value) => { values.set(key, structuredClone(value)); }),
      delete: vi.fn(async key => { values.delete(key); }), keys: async () => [...values.keys()],
    };
    storages.set(id, storage);
    return { clock, log, storage, settings: { get: () => undefined, onChange: () => () => {} },
      secrets: { get: async () => undefined, onChange: () => () => {} } };
  } });
  let ids = [...saved];
  const settings = { enabledPlugins: () => [...ids], setEnabledPlugins: vi.fn(async (next: string[]) => { ids = [...next]; }) };
  const messages: Envelope[] = [];
  kernel.observe(message => { messages.push(message); });
  const host = registerPluginHost(kernel, plugins, settings);
  const bus = kernel.createBus('shell');
  registerShell(bus, async () => {}, clock, () => {});
  const toggle = (pluginId: string, enabled: boolean) => bus.request('shell/set-plugin-enabled', { pluginId, enabled });
  return { kernel, host, bus, settings, toggle, data, storages, messages, timers, log };
}
const optional = (setup: MainPlugin['setup'] = () => {}): MainPlugin => ({
  manifest: { id: 'example', name: 'Example', description: 'Example plugin', version: '1', optional: true }, setup,
});
const core: MainPlugin = { manifest: { id: 'core', name: 'Core', version: '1' }, setup: () => {} };

it('loads one startup batch, defaults optional off, ignores unknown ids and reports every plugin', async () => {
  const setup = vi.fn();
  const f = fixture([core, optional(setup)], ['unknown']);
  await f.host.start();
  expect(setup).not.toHaveBeenCalled();
  expect((await f.bus.request('shell/plugins', {})).plugins).toEqual([
    { id: 'core', name: 'Core', optional: false, enabled: true, state: 'loaded' },
    { id: 'example', name: 'Example', description: 'Example plugin', optional: true, enabled: false, state: 'off' },
  ]);
  expect(f.messages.filter(m => m.type === 'kernel/ready')).toHaveLength(1);
  const result = await f.toggle('example', true);
  expect(setup).toHaveBeenCalledOnce();
  expect(result.plugins[1]).toMatchObject({ enabled: true, state: 'loaded' });
  expect(f.messages.filter(m => m.type === 'shell/plugins-changed')[0]!.payload).toEqual(result);
  expect(f.messages.filter(m => m.type === 'kernel/ready').at(-1)!.payload).toEqual({ pluginIds: ['core', 'example'] });
  const restarted = fixture([core, optional()], f.settings.enabledPlugins());
  await restarted.host.start();
  expect((await restarted.bus.request('shell/plugins', {})).plugins[1]!.state).toBe('loaded');
  expect(restarted.messages.filter(m => m.type === 'kernel/ready')).toHaveLength(1);
});

it('unloads resources while preserving data, restores on reenable, serializes toggles and ignores repeats', async () => {
  const cleaned = vi.fn();
  const reads: unknown[] = [];
  const f = fixture([optional(async ctx => {
    reads.push(await ctx.storage.get('kept'));
    await ctx.storage.set('kept', { count: 7 });
    ctx.clock.setTimeout(() => {}, 1000);
    ctx.onDispose(cleaned);
  })]);
  await f.host.start();
  await Promise.all([f.toggle('example', true), f.toggle('example', true), f.toggle('example', false), f.toggle('example', true)]);
  expect(reads).toEqual([undefined, { count: 7 }]);
  expect(cleaned).toHaveBeenCalledOnce();
  expect(f.messages.filter(m => m.type === 'shell/plugins-changed')).toHaveLength(3);
  expect(f.settings.setEnabledPlugins).toHaveBeenCalledTimes(3);
  expect(f.storages.get('example')!.delete).not.toHaveBeenCalled();
  await f.toggle('example', false);
  expect(f.timers.size).toBe(0);
});

it('keeps failures selected, does not retry repeated enables, and retries after disabling', async () => {
  const setup = vi.fn().mockRejectedValueOnce(new Error('broken')).mockResolvedValue(undefined);
  const f = fixture([optional(setup)], ['example']);
  await f.host.start();
  expect((await f.bus.request('shell/plugins', {})).plugins[0]).toMatchObject({ enabled: true, state: 'failed' });
  await f.toggle('example', true); expect(setup).toHaveBeenCalledOnce();
  expect((await f.toggle('example', false)).plugins[0]).toMatchObject({ enabled: false, state: 'off' });
  expect((await f.toggle('example', true)).plugins[0]).toMatchObject({ enabled: true, state: 'loaded' });
  expect(setup).toHaveBeenCalledTimes(2);
  expect(f.settings.enabledPlugins()).toEqual(['example']);
});

it('reports a runtime setup failure as failed while retaining the persisted selection', async () => {
  const f = fixture([optional(() => { throw new Error('broken'); })]); await f.host.start();
  expect((await f.toggle('example', true)).plugins[0]).toMatchObject({ enabled: true, state: 'failed' });
  expect(f.settings.enabledPlugins()).toEqual(['example']);
  expect(f.messages.filter(m => m.type === 'shell/plugins-changed')).toHaveLength(1);
});

it('rejects unknown, builtin and malformed toggles without any writes or events', async () => {
  const f = fixture([core, optional()]); await f.host.start();
  for (const payload of [{ pluginId: 'core', enabled: false }, { pluginId: 'unknown', enabled: true },
    { pluginId: 'example', enabled: 'true' }, {}, null]) {
    await expect(f.bus.request('shell/set-plugin-enabled', payload as RequestPayload<'shell/set-plugin-enabled'>))
      .rejects.toMatchObject({ code: 'shell/invalid-input' });
  }
  expect(f.settings.setEnabledPlugins).not.toHaveBeenCalled();
  expect(f.messages.filter(m => m.type === 'shell/plugins-changed')).toEqual([]);
});

it('leaves runtime unchanged when persistence fails and stops handlers on shutdown', async () => {
  const setup = vi.fn(); const f = fixture([optional(setup)]); await f.host.start();
  f.settings.setEnabledPlugins.mockRejectedValueOnce(new Error('disk full'));
  await expect(f.toggle('example', true)).rejects.toThrow('disk full');
  expect(setup).not.toHaveBeenCalled();
  expect((await f.bus.request('shell/plugins', {})).plugins[0]!.enabled).toBe(false);
  await f.toggle('example', true);
  f.settings.setEnabledPlugins.mockRejectedValueOnce(new Error('disk full'));
  await expect(f.toggle('example', false)).rejects.toThrow('disk full');
  expect((await f.bus.request('shell/plugins', {})).plugins[0]!.state).toBe('loaded');
  await f.host.dispose();
  await expect(f.bus.request('shell/plugins', {})).rejects.toMatchObject({ code: 'no-handler' });
});

it('does not double-book or emit builtin events on another kernel/ready', async () => {
  const f = fixture([...builtin.filter(p => !p.manifest.optional), optional()]);
  await f.host.start();
  const drain = async () => {
    for (let i = 0; i < 15; i++) {
      await f.bus.request('scribe/state', {});
      await f.bus.request('character/sheet', {});
      await f.bus.request('notes/list', {});
    }
  };
  await drain();
  const { quest } = await f.bus.request('quest/create', { input: { kind: 'side', title: 'One deed', attributes: ['learning'] } });
  await f.bus.request('quest/complete', { id: quest.id });
  await drain();
  const character = await f.bus.request('character/sheet', {});
  const before = structuredClone(f.data);
  f.messages.length = 0;
  await f.toggle('example', true); await drain();
  expect(await f.bus.request('character/sheet', {})).toEqual(character);
  expect(f.data).toEqual(before.has('example') ? before : new Map([...before, ['example', new Map()]]));
  expect(f.messages.filter(m => m.kind === 'event' &&
    !m.type.startsWith('kernel/') && m.type !== 'shell/plugins-changed')).toEqual([]);
  expect(f.log.error).not.toHaveBeenCalled();
});

it('marks setup timeouts failed and cleans resources without losing the selection', async () => {
  const cleaned = vi.fn();
  const f = fixture([optional(ctx => {
    ctx.onDispose(cleaned);
    return new Promise<void>(() => {});
  })], ['example']);
  const starting = f.host.start();
  await Promise.resolve();
  for (const callback of [...f.timers]) callback();
  await starting;
  expect((await f.bus.request('shell/plugins', {})).plugins[0]).toMatchObject({ enabled: true, state: 'failed' });
  expect(cleaned).toHaveBeenCalledOnce();
  expect(f.settings.enabledPlugins()).toEqual(['example']);
});

it('registers the real flashcards example as optional and restores its library on reenable', async () => {
  const f = fixture(builtin); await f.host.start();
  expect((await f.bus.request('shell/plugins', {})).plugins.find(p => p.id === 'flashcards'))
    .toMatchObject({ optional: true, enabled: false, state: 'off' });
  await expect(f.bus.request('flashcards/next', {})).rejects.toMatchObject({ code: 'no-handler' });
  await f.toggle('flashcards', true);
  const { card } = await f.bus.request('flashcards/create', { input: { question: 'RDB?', answer: 'Snapshot' } });
  await f.bus.request('flashcards/grade', { id: card.id, grade: 'good' });
  await f.toggle('flashcards', false);
  await expect(f.bus.request('flashcards/list', {})).rejects.toMatchObject({ code: 'no-handler' });
  await f.toggle('flashcards', true);
  const { cards } = await f.bus.request('flashcards/list', {});
  expect(cards).toHaveLength(1); expect(cards[0]!.review.reviews).toBe(1);
});
