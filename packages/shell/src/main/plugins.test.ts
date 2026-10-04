import { expect, it, vi } from 'vitest';
import { createKernel } from '@featherlog/kernel';
import type { Clock, Envelope, Json, PluginStorage } from '@featherlog/contracts';
import { plugins } from './plugins';

it('loads plugins with only MainContext and carries kernel origins through real quest handlers', async () => {
  const clock: Clock = { now: () => new Date('2026-10-03T12:00:00').getTime(), setTimeout: () => () => {} };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const stores = new Map<string, Map<string, Json>>();
  const kernel = createKernel({ clock, log, createServices(id) {
    const data = new Map<string, Json>(); stores.set(id, data);
    const storage: PluginStorage = { async get<T extends Json>(key: string) { return data.get(key) as T | undefined; },
      async set(key, value) { data.set(key, value); }, async delete(key) { data.delete(key); }, async keys() { return [...data.keys()]; } };
    return { clock, log, storage, settings: {
      get<T extends Json>(key: string) { return (id === 'scribe' && key === 'enabled' ? true : undefined) as T | undefined; },
      onChange: () => () => {},
    },
      secrets: { get: async () => undefined, onChange: () => () => {} } };
  } });
  const shell = kernel.createBus('shell');
  shell.handle('shell/set-badge', () => null);
  shell.handle('shell/open-panel', (_, envelope) => {
    shell.emit('shell/view-changed', { view: 'panel' }, { causedBy: envelope.id }); return null;
  });
  const ui = kernel.createBus('quest');
  const seen: Envelope[] = [];
  ui.on('quest/created', (_, envelope) => { seen.push(envelope); });
  ui.on('shell/view-changed', (_, envelope) => { seen.push(envelope); });
  await kernel.load(plugins);
  await ui.request('quest/create', { input: { kind: 'side', title: '本机' } });
  expect(seen.at(-1)?.origin).toBe('quest');
  expect(Object.isFrozen(seen.at(-1))).toBe(true);
  for (const actor of ['scribe', 'external:test', 'shell', 'another-plugin']) {
    await kernel.createBus(actor).request('quest/create', { input: { kind: 'side', title: actor } });
    expect(seen.at(-1)?.origin).toBe(actor);
  }
  for (const actor of ['scribe', 'external:test', 'quest', 'shell']) {
    await kernel.createBus(actor).request('shell/open-panel', {});
    expect(seen.at(-1)?.origin).toBe(actor);
  }
  shell.emit('shell/view-changed', { view: 'collapsed' }); await Promise.resolve();
  expect(seen.at(-1)).not.toHaveProperty('origin');
  const quests = (await ui.request('quest/list', {})).quests;
  await kernel.createBus('scribe').request('quest/complete', { id: quests[0]!.id });
  for (let i = 0; i < 10; i++) await ui.request('scribe/state', {});
  expect((await ui.request('scribe/lines', {})).lines).toEqual([]);
  await ui.request('quest/complete', { id: quests[1]!.id });
  for (let i = 0; i < 20; i++) await ui.request('scribe/state', {});
  expect((await ui.request('scribe/lines', {})).lines).toMatchObject([{ topic: 'quest', origin: 'builtin' }]);
  expect((await ui.request('scribe/epilogue', { questId: quests[1]!.id })).epilogue).not.toBeNull();
  expect(stores.has('scribe')).toBe(true);
  kernel.unload('scribe'); kernel.unload('quest');
});
