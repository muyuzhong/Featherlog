import { afterEach, expect, it, vi } from 'vitest';
import type { FeatherlogPreload } from '@featherlog/contracts';

const mocks = vi.hoisted(() => ({ expose: vi.fn(), send: vi.fn(), invoke: vi.fn(),
  on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { send: mocks.send, invoke: mocks.invoke,
    on: mocks.on, removeListener: mocks.removeListener },
}));
const originalArgs = [...process.argv];
afterEach(() => {
  process.argv = [...originalArgs];
  vi.clearAllMocks();
  vi.resetModules();
});
async function load(kind: 'collapsed' | 'panel') {
  process.argv = [...originalArgs, `--featherlog-window=${kind}`, '--featherlog-dock=electron'];
  await import('./index');
  expect(mocks.expose.mock.calls[0]![0]).toBe('featherlog');
  return mocks.expose.mock.calls[0]![1] as FeatherlogPreload;
}

it('exposes only the contract and strips Electron events from callbacks', async () => {
  const api = await load('collapsed');
  expect(Object.keys(api).sort()).toEqual(['bus', 'dock', 'panel', 'platform', 'settings', 'window']);
  expect(api.window.kind).toBe('collapsed');
  expect(api.platform.dock).toEqual({ anchored: true, keepAbove: true, focusSafe: true });
  const listener = vi.fn();
  const off = api.bus.onDeliver(listener);
  const callback = mocks.on.mock.calls[0]![1] as (...args: unknown[]) => void;
  const payload = { id: 'message' };
  callback({ privileged: true }, payload);
  expect(listener).toHaveBeenCalledWith(payload);
  off();
  expect(mocks.removeListener).toHaveBeenCalledWith('bus:deliver', callback);
  api.bus.subscribe(['shell/view-changed']);
  api.bus.unsubscribe(['shell/view-changed']);
  expect(mocks.send).toHaveBeenCalledWith('bus:subscribe', ['shell/view-changed']);
  expect(mocks.send).toHaveBeenCalledWith('bus:unsubscribe', ['shell/view-changed']);
});

it.each(['collapsed', 'panel'] as const)('limits %s window operations', async kind => {
  const api = await load(kind);
  const size = { width: 80, height: 320, expanded: false };
  api.dock.resize(size);
  api.dock.menu();
  api.panel.close();
  expect(mocks.send.mock.calls.map(call => call[0])).toEqual(kind === 'collapsed'
    ? ['dock:resize', 'dock:menu'] : ['panel:close']);
});

it('preserves setting rejection codes as cloneable data for contextBridge', async () => {
  const api = await load('panel');
  mocks.invoke.mockResolvedValueOnce({ error: {
    code: 'shell/invalid-setting', message: 'Invalid setting',
  } });
  await expect(api.settings.set('shell', 'edge', 'bad')).rejects.toEqual({
    code: 'shell/invalid-setting', message: 'Invalid setting',
  });
  mocks.invoke.mockResolvedValueOnce({});
  await expect(api.settings.set('shell', 'edge', 'left')).resolves.toBeUndefined();
});
