import { afterEach, expect, it, vi } from 'vitest';
import { createKernel, type MainPlugin } from '@featherlog/kernel';
import type { Envelope, Json } from '@featherlog/contracts';
import { createHostShell } from './shell';
import { createSettings } from './settings';
import { clearAll } from './persist';
import { createStorage } from './storage';

afterEach(clearAll);
function fixture(fails = false) {
  const seen: unknown[] = [];
  const plugin: MainPlugin = { manifest: { id: 'example', name: 'Example', optional: true, version: '1',
    contributes: { settings: { schema: { properties: { amount: { type: 'integer', default: 10 } } } } } },
    async setup(ctx) {
      if (fails) throw new Error('setup failed');
      seen.push(await ctx.storage.get('data'));
      await ctx.storage.set('data', { value: 42 });
    } };
  const settings = createSettings([plugin.manifest]);
  const clock = { now: () => 0, setTimeout: () => () => {} };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const kernel = createKernel({ clock, log, development: true, createServices: id => ({
    clock, log, storage: createStorage(id), settings: settings.forPlugin(id),
    secrets: { get: async () => undefined, onChange: () => () => {} },
  }) });
  const messages: Envelope[] = [];
  kernel.observe(message => { messages.push(message); });
  const shell = createHostShell(kernel, [plugin], settings);
  return { shell, settings, seen, messages };
}

it('serves optional-plugin requests in the playground and preserves state/settings across reload', async () => {
  const f = fixture(); await f.shell.plugins.start();
  expect((await f.shell.bus.request('shell/plugins', {})).plugins[0]).toMatchObject({ state: 'off', enabled: false });
  expect(() => f.settings.set('shell', 'enabledPlugins', ['example'])).toThrow();
  f.settings.set('example', 'amount', 17);
  await f.shell.bus.request('shell/set-plugin-enabled', { pluginId: 'example', enabled: true });
  expect(f.seen).toEqual([undefined]);
  expect(f.messages.filter(m => m.type === 'shell/plugins-changed')).toHaveLength(1);
  const reloaded = fixture(); await reloaded.shell.plugins.start();
  expect(reloaded.seen).toEqual([{ value: 42 }]);
  expect(reloaded.settings.forPlugin('example').get<Json>('amount')).toBe(17);
  await reloaded.shell.bus.request('shell/set-plugin-enabled', { pluginId: 'example', enabled: false });
  const off = fixture(); await off.shell.plugins.start();
  expect(off.seen).toEqual([]);
  await off.shell.bus.request('shell/set-plugin-enabled', { pluginId: 'example', enabled: true });
  expect(off.seen).toEqual([{ value: 42 }]);
  expect(off.settings.forPlugin('example').get('amount')).toBe(17);
});

it('keeps a failed optional plugin selected in the playground', async () => {
  const f = fixture(true); await f.shell.plugins.start();
  expect((await f.shell.bus.request('shell/set-plugin-enabled', { pluginId: 'example', enabled: true })).plugins[0])
    .toMatchObject({ enabled: true, state: 'failed' });
  expect(f.settings.enabledPlugins()).toEqual(['example']);
});
