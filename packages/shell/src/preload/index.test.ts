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
async function load(kind: 'collapsed' | 'panel', dock = 'electron') {
  process.argv = [...originalArgs, `--featherlog-window=${kind}`, `--featherlog-dock=${dock}`];
  await import('./index');
  expect(mocks.expose.mock.calls[0]![0]).toBe('featherlog');
  return mocks.expose.mock.calls[0]![1] as FeatherlogPreload;
}

it('exposes only the contract and strips Electron events from callbacks', async () => {
  const api = await load('collapsed');
  expect(Object.keys(api).sort()).toEqual(['bus', 'dock', 'panel', 'platform', 'settings', 'window']);
  expect(api.window.kind).toBe('collapsed');
  expect(api.platform.dock).toEqual({ anchored: false, keepAbove: true, focusSafe: true });
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

it('writes and deletes secrets over dedicated IPC and exposes only their presence', async () => {
  const api = await load('panel');
  expect(Object.keys(api.settings).sort()).toEqual(['all', 'hasSecret', 'onChange', 'set', 'setSecret']);
  mocks.invoke.mockResolvedValueOnce({ value: null });
  await expect(api.settings.setSecret('scribe', 'apiKey', 'private-key')).resolves.toBeUndefined();
  expect(mocks.invoke).toHaveBeenLastCalledWith('settings:set-secret', 'scribe', 'apiKey', 'private-key');
  mocks.invoke.mockResolvedValueOnce({ value: true });
  await expect(api.settings.hasSecret('scribe', 'apiKey')).resolves.toBe(true);
  expect(mocks.invoke).toHaveBeenLastCalledWith('settings:has-secret', 'scribe', 'apiKey');
  mocks.invoke.mockResolvedValueOnce({ value: null });
  await expect(api.settings.setSecret('scribe', 'apiKey', '')).resolves.toBeUndefined();
  mocks.invoke.mockResolvedValueOnce({ value: false });
  await expect(api.settings.hasSecret('scribe', 'apiKey')).resolves.toBe(false);
  expect(mocks.send).not.toHaveBeenCalled();
});

it.each(['shell/invalid-setting', 'shell/secrets-unavailable'])(
  'preserves secret error %s across contextBridge without native Error fields', async code => {
    const api = await load('panel');
    const error = { code, message: 'Secret request failed' };
    mocks.invoke.mockResolvedValueOnce({ error });
    await expect(api.settings.setSecret('scribe', 'apiKey', 'private-key')).rejects.toEqual(error);
    mocks.invoke.mockResolvedValueOnce({ error });
    await expect(api.settings.hasSecret('scribe', 'apiKey')).rejects.toEqual(error);
  },
);

it.each(['kwin', 'plain'])('reports %s float capabilities', async dock => {
  const api = await load('collapsed', dock);
  expect(api.platform.dock).toEqual({ anchored: false, keepAbove: dock === 'kwin', focusSafe: false });
});

it('reads and subscribes to unfold direction only in the collapsed window', async () => {
  const api = await load('collapsed');
  mocks.invoke.mockResolvedValueOnce('right');
  await expect(api.dock.side!()).resolves.toBe('right');
  expect(mocks.invoke).toHaveBeenCalledWith('dock:side');
  const listener = vi.fn();
  const off = api.dock.onSide!(listener);
  const callback = mocks.on.mock.calls.at(-1)![1] as (...args: unknown[]) => void;
  callback({ privileged: true }, 'left');
  expect(listener).toHaveBeenCalledWith('left');
  off();
  expect(mocks.removeListener).toHaveBeenCalledWith('dock:side-changed', callback);
});

it('does not expose unfold direction controls to the panel', async () => {
  const api = await load('panel');
  expect(api.dock.side).toBeUndefined();
  expect(api.dock.onSide).toBeUndefined();
});
