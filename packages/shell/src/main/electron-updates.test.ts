import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createKernel } from '@featherlog/kernel';
import type { Clock } from '@featherlog/contracts';
import { JsonFiles } from './storage';
import { Settings } from './settings';
import { startUpdates } from './electron-updates';

const electron = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => '0.1.0', getPath: vi.fn() },
  shell: { openExternal: vi.fn(async () => {}) },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  constructor: vi.fn(),
}));
vi.mock('electron', () => electron);
vi.mock('electron-updater', () => ({ default: {
  AppImageUpdater: electron.constructor, MacUpdater: electron.constructor,
  NsisUpdater: electron.constructor,
} }));
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(packaged = true) {
  const directory = await mkdtemp(join(tmpdir(), 'featherlog-updates-'));
  directories.push(directory);
  electron.app.isPackaged = packaged;
  electron.app.getPath.mockReturnValue(directory);
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let now = 0;
  const timers = new Map<() => void, number>();
  const clock: Clock = { now: () => now, setTimeout(callback, ms) {
    timers.set(callback, now + ms);
    return () => { timers.delete(callback); };
  } };
  const files = new JsonFiles(clock);
  const settings = new Settings(directory, [], undefined, files, log);
  const kernel = createKernel({ clock, log, createServices: () => { throw new Error('No plugins'); } });
  const bus = kernel.createBus('shell');
  const notify = vi.fn(() => null);
  bus.handle('shell/notify', notify);
  const updater = Object.assign(new EventEmitter(), {
    netSession: { webRequest: { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn() } },
    setFeedURL: vi.fn(), allowPrerelease: true, allowDowngrade: true,
    autoDownload: true, autoInstallOnAppQuit: false,
    isUserWithinRollout: () => false, isUpdaterActive: () => false,
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: false,
      updateInfo: { version: '0.2.0' } })),
    downloadUpdate: vi.fn(async () => []), quitAndInstall: vi.fn(),
  });
  electron.constructor.mockImplementation(function () { return updater; });
  const quitToInstall = vi.fn();
  const start = () => startUpdates(bus, clock, log, settings, files, quitToInstall);
  return { directory, updater, notify, settings, files, bus, timers, quitToInstall, start,
    resume() {
      now += 7 * 3_600_000;
      const resume = electron.powerMonitor.on.mock.calls.at(-1)![1] as () => void;
      resume();
    },
  };
}

it('configures only public stable GitHub releases, privacy filters and install-on-quit', async () => {
  vi.stubEnv('APPIMAGE', '/test/Featherlog.AppImage');
  const f = await fixture();
  const stop = f.start();
  expect(f.updater.setFeedURL).toHaveBeenCalledWith({
    provider: 'github', owner: 'muyuzhong', repo: 'Featherlog',
  });
  expect(f.updater.allowPrerelease).toBe(false);
  expect(f.updater.allowDowngrade).toBe(false);
  expect(f.updater.isUserWithinRollout()).toBe(true);
  expect(f.updater.autoInstallOnAppQuit).toBe(process.platform === 'linux');
  expect(f.updater.netSession.webRequest.onBeforeSendHeaders).toHaveBeenCalledOnce();
  await f.settings.set('shell', 'autoUpdate', false);
  expect(f.timers.size).toBe(0);
  f.resume();
  expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
  await f.settings.set('shell', 'autoUpdate', true);
  f.resume();
  expect(f.updater.checkForUpdates).toHaveBeenCalledOnce();
  stop();
  expect(electron.powerMonitor.removeListener).toHaveBeenCalledWith('resume', expect.any(Function));
});

it('allows packaged manual installations to check without enabling downloads', async () => {
  vi.stubEnv('APPIMAGE', '');
  const f = await fixture();
  const stop = f.start();
  expect(f.updater.isUpdaterActive()).toBe(true);
  expect(f.updater.autoDownload).toBe(false);
  expect(f.updater.autoInstallOnAppQuit).toBe(false);
  stop();
});

it('does not even construct electron-updater in development', async () => {
  const f = await fixture(false);
  const stop = f.start();
  expect(electron.constructor).not.toHaveBeenCalled();
  expect(await f.bus.request('shell/update-state', {})).toEqual({
    current: '0.1.0', status: 'unsupported',
  });
  stop();
});

it.skipIf(process.platform !== 'linux')(
  'persists notifications and hands installation to normal shutdown', async () => {
  vi.stubEnv('APPIMAGE', '/test/Featherlog.AppImage');
  const f = await fixture();
  f.updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true,
    updateInfo: { version: '0.2.0' } });
  const stop = f.start();
  await f.bus.request('shell/check-update', {});
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
  await f.files.flush();
  expect(JSON.parse(await readFile(join(f.directory, 'updates.json'), 'utf8'))).toEqual(['0.2.0']);
  stop();
  f.notify.mockClear();
  const restarted = f.start();
  await f.bus.request('shell/check-update', {});
  await vi.waitFor(async () => expect((await f.bus.request('shell/update-state', {})).status)
    .toBe('ready'));
  expect(f.notify).not.toHaveBeenCalled();
  await f.bus.request('shell/apply-update', {});
  expect(f.quitToInstall).not.toHaveBeenCalled();
  for (const [callback, at] of f.timers) {
    if (at === 0) callback();
  }
  expect(f.quitToInstall).toHaveBeenCalledOnce();
  expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
  await f.files.flush();
  const install = f.quitToInstall.mock.calls[0]![0] as () => void;
  install();
  expect(f.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
  restarted();
});
