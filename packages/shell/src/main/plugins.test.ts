import { expect, it, vi } from 'vitest';
import { createKernel } from '@featherlog/kernel';
import type { Clock, Envelope, Json, PluginStorage } from '@featherlog/contracts';
import { createPlugins } from './plugins';

it('associates quest events with the original actor, retaining the association after the response', async () => {
  const clock: Clock = { now: () => new Date('2026-10-03T12:00:00').getTime(), setTimeout: () => () => {} };
  const composition = createPlugins();
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const stores = new Map<string, Map<string, Json>>();
  const kernel = createKernel({ clock, log, createServices(id) {
    const data = new Map<string, Json>(); stores.set(id, data);
    const storage: PluginStorage = { async get<T extends Json>(key: string) { return data.get(key) as T | undefined; },
      async set(key, value) { data.set(key, value); }, async delete(key) { data.delete(key); }, async keys() { return [...data.keys()]; } };
    return { clock, log, storage, settings: { get: () => undefined, onChange: () => () => {} },
      secrets: { get: async () => undefined, onChange: () => () => {} } };
  } });
  kernel.observe(composition.observe);
  const shell = kernel.createBus('shell');
  shell.handle('shell/set-badge', () => null);
  shell.handle('shell/open-panel', (_, envelope) => {
    shell.emit('shell/view-changed', { view: 'panel' }, { causedBy: envelope.id }); return null;
  });
  const ui = kernel.createBus('quest');
  const seen: { message: Envelope; local: boolean }[] = [];
  ui.on('quest/created', (_, envelope) => { seen.push({ message: envelope, local: composition.isLocalAction(envelope) }); });
  ui.on('shell/view-changed', (_, envelope) => { seen.push({ message: envelope, local: composition.isLocalAction(envelope) }); });
  await kernel.load(composition.plugins);
  await ui.request('quest/create', { input: { kind: 'side', title: '本机' } });
  expect(seen.at(-1)?.local).toBe(true);
  expect(composition.isLocalAction(seen.at(-1)!.message)).toBe(true);
  for (const actor of ['scribe', 'external:test', 'shell', 'another-plugin']) {
    await kernel.createBus(actor).request('quest/create', { input: { kind: 'side', title: actor } });
    expect(seen.at(-1)?.local).toBe(false);
  }
  for (const actor of ['scribe', 'external:test', 'quest', 'shell']) {
    await kernel.createBus(actor).request('shell/open-panel', {});
    expect(seen.at(-1)?.local).toBe(actor === 'quest' || actor === 'shell');
  }
  shell.emit('shell/view-changed', { view: 'collapsed' }); await Promise.resolve();
  expect(seen.at(-1)?.local).toBe(true);
  const last = seen.at(-1)!.message;
  expect(composition.isLocalAction({ ...last, source: 'external:test' })).toBe(false);
  expect(composition.isLocalAction({ ...last, type: 'quest/created', source: 'quest' })).toBe(false);
  expect(composition.isLocalAction({ ...last, type: 'shell/notified' })).toBe(false);
  expect(stores.has('scribe')).toBe(true);
  kernel.unload('scribe'); kernel.unload('quest');
});
