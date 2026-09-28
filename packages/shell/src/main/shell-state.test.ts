import { expect, it, vi } from 'vitest';
import { createKernel } from '@featherlog/kernel';
import type { Envelope, PluginStorage } from '@featherlog/contracts';
import { registerShell } from './shell-state';

function fixture() {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = { now: () => 1, setTimeout: () => () => {} };
  const storage: PluginStorage = { get: async () => undefined,
    set: async () => {}, delete: async () => {}, keys: async () => [] };
  const kernel = createKernel({ development: true, clock, log, createServices: () => ({
    clock, log, storage, settings: { get: () => undefined, onChange: () => () => {} },
  }) });
  const bus = kernel.createBus('shell');
  const open = vi.fn(async () => {});
  const shell = registerShell(bus, open);
  const messages: Envelope[] = [];
  kernel.observe(message => messages.push(message));
  return { bus, shell, messages, open };
}

it('returns initial state, remembers panel params and emits causedBy-linked shell events', async () => {
  const { bus, shell, messages, open } = fixture();
  await expect(bus.request('shell/state', {})).resolves.toEqual({
    view: 'collapsed', badges: {}, panel: {},
  });
  await bus.request('shell/open-panel', { tab: 'example/tab', params: { id: 'one' } });
  expect(open).toHaveBeenCalledOnce();
  expect(messages.find(m => m.type === 'shell/view-changed')).toMatchObject({
    payload: { view: 'panel', tabId: 'example/tab', params: { id: 'one' } },
    causedBy: messages.find(m => m.type === 'shell/open-panel')!.id,
  });
  shell.view('preview');
  await expect(bus.request('shell/state', {})).resolves.toMatchObject({
    view: 'preview', panel: { tab: 'example/tab', params: { id: 'one' } },
  });
  await bus.request('shell/set-badge', { iconId: 'example/icon', badge: { kind: 'progress', value: .5 } });
  const state = await bus.request('shell/state', {});
  expect(state.badges['example/icon']).toEqual({ kind: 'progress', value: .5 });
  expect(messages.find(m => m.type === 'shell/badge-changed')!.causedBy)
    .toBe(messages.find(m => m.type === 'shell/set-badge')!.id);
  await bus.request('shell/set-badge', { iconId: 'example/icon', badge: null });
  await expect(bus.request('shell/state', {})).resolves.toMatchObject({
    badges: { 'example/icon': null },
  });
});

it('notifies with unique ids, leaves popups unhandled and disposes registrations', async () => {
  const { bus, shell, messages } = fixture();
  await bus.request('shell/notify', { title: 'Hello' });
  await bus.request('shell/notify', { title: 'Hello' });
  const events = messages.filter(m => m.type === 'shell/notified');
  expect(events).toHaveLength(2);
  expect(events[0]!.payload).toMatchObject({ notification: { title: 'Hello' } });
  expect((events[0]!.payload as { id: string }).id)
    .not.toBe((events[1]!.payload as { id: string }).id);
  await expect(bus.request('shell/show-popup', { type: 'example/popup' }))
    .rejects.toMatchObject({ code: 'no-handler' });
  shell.dispose();
  await expect(bus.request('shell/state', {})).rejects.toMatchObject({ code: 'no-handler' });
});

it('rejects invalid badge and notification inputs without events or state changes', async () => {
  const { bus, messages } = fixture();
  await expect(bus.request('shell/set-badge', {
    iconId: 'example/icon', badge: { kind: 'progress', value: 2 },
  })).rejects.toMatchObject({ code: 'shell/invalid-input' });
  await expect(bus.request('shell/notify', { title: '' }))
    .rejects.toMatchObject({ code: 'shell/invalid-input' });
  await expect(bus.request('shell/notify', {
    title: 'Hello', variant: ['success'] as unknown as 'success',
  })).rejects.toMatchObject({ code: 'shell/invalid-input' });
  expect(messages.filter(m => m.kind === 'event')).toEqual([]);
  await expect(bus.request('shell/state', {})).resolves.toMatchObject({ badges: {} });
});
