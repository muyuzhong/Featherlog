import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '@featherlog/kernel';
import type { Clock, UpdateState } from '@featherlog/contracts';
import type { UpdateCheckResult, UpdateInfo } from 'electron-updater';
import { registerUpdates, releaseNotes, updateMode } from './updates';
import type { UpdateMode } from './updates';

const hour = 3_600_000;
const info: UpdateInfo = { version: '0.2.0', releaseDate: '2026-09-28T00:00:00Z', files: [],
  path: '', sha512: '', releaseNotes: '<p>New &amp; improved</p>' };
const result = (available = true, updateInfo = info): UpdateCheckResult => ({
  isUpdateAvailable: available, updateInfo, versionInfo: updateInfo,
});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  checkForUpdates = vi.fn(async (): Promise<UpdateCheckResult | null> => result(false));
  downloadUpdate = vi.fn(async () => ['update.AppImage']);
}
function fixture(mode: UpdateMode = 'automatic', automatic = true, notifiedVersions: string[] = []) {
  let time = 0;
  const timers = new Map<() => void, number>();
  const clock: Clock = {
    now: () => time,
    setTimeout(callback, delay) {
      timers.set(callback, time + delay);
      return () => { timers.delete(callback); };
    },
  };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const kernel = createKernel({ development: true, clock, log,
    createServices: () => { throw new Error('No plugins in update tests'); } });
  const bus = kernel.createBus('shell');
  const notify = vi.fn(() => null);
  bus.handle('shell/notify', notify);
  const changes: UpdateState[] = [];
  bus.on('shell/update-changed', state => { changes.push(state); });
  const updater = new FakeUpdater();
  const createUpdater = vi.fn(() => new FakeUpdater()).mockReturnValueOnce(updater);
  const openExternal = vi.fn(async (_url: string) => {});
  const quitToInstall = vi.fn();
  const saveNotified = vi.fn(async (_versions: string[]) => {});
  const updates = registerUpdates({ bus, clock, log, current: '0.1.0', mode, createUpdater,
    automatic, openExternal, quitToInstall, notifiedVersions, saveNotified });
  return { updater, createUpdater, bus, log, changes, notify, saveNotified, openExternal, quitToInstall, updates, timers,
    state: () => bus.request('shell/update-state', {}),
    check: async () => { const answer = await bus.request('shell/check-update', {});
      await flush(); return answer; },
    apply: () => bus.request('shell/apply-update', {}),
    sleep(ms: number) { time += ms; },
    async advance(ms: number) {
      const target = time + ms;
      for (;;) {
        const due = [...timers].filter(([, at]) => at <= target).sort((a, b) => a[1] - b[1])[0];
        if (!due) break;
        time = Math.max(time, due[1]);
        timers.delete(due[0]);
        due[0]();
        await flush();
      }
      time = target;
      await flush();
    },
  };
}

describe('installation detection', () => {
  it.each([
    [false, 'win32', undefined, true, 'unsupported'],
    [false, 'linux', '/app.AppImage', false, 'unsupported'],
    [false, 'darwin', undefined, false, 'unsupported'],
    [true, 'win32', undefined, true, 'automatic'],
    [true, 'win32', undefined, false, 'manual'],
    [true, 'linux', '/app.AppImage', false, 'automatic'],
    [true, 'linux', '', false, 'manual'],
    [true, 'linux', undefined, false, 'manual'],
    [true, 'darwin', undefined, false, 'manual'],
  ] as const)('%s %s %s %s -> %s', (packaged, platform, image, nsis, expected) => {
    expect(updateMode(packaged, platform, image, nsis)).toBe(expected);
  });
});

it.each(['unsupported', 'managed'] as const)(
  '%s never accesses the updater, including manual checks and resume', async mode => {
    const f = fixture(mode);
    expect(await f.state()).toEqual({ current: '0.1.0', status: mode });
    expect(await f.check()).toBeNull();
    await f.advance(24 * hour);
    f.updates.resume();
    f.updates.setAutomatic(false);
    f.updates.setAutomatic(true);
    expect(await f.check()).toBeNull();
    expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
    expect(f.changes).toEqual([]);
    await expect(f.apply()).rejects.toMatchObject({ code: 'shell/no-update' });
  },
);

it('checks at 30 seconds and every 6 hours, sending complete states', async () => {
  const f = fixture();
  expect(await f.state()).toEqual({ current: '0.1.0', status: 'idle' });
  await f.advance(29_999);
  expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
  await f.advance(1);
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(f.changes).toEqual([
    { current: '0.1.0', status: 'checking' },
    { current: '0.1.0', status: 'latest', checkedAt: '1970-01-01T00:00:30.000Z' },
  ]);
  await f.advance(6 * hour - 1);
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  await f.advance(1);
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  await f.advance(6 * hour);
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(3);
});

it('catches up after sleep without timer delivery, using the last manual or automatic check', async () => {
  const f = fixture();
  await f.check();
  f.sleep(6 * hour);
  f.updates.resume();
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  f.sleep(1);
  f.updates.resume();
  f.updates.resume();
  await flush();
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  await f.advance(0);
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  await f.advance(6 * hour);
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(3);
});

it('catches up on resume even when the initial timer never ran', async () => {
  const f = fixture();
  f.sleep(7 * hour);
  f.updates.resume();
  await flush();
  expect(f.updater.checkForUpdates).toHaveBeenCalledOnce();
});

it('disabling autoUpdate cancels timers and resume, but manual checks still download', async () => {
  const f = fixture('automatic', false);
  f.updater.checkForUpdates.mockResolvedValue(result());
  await f.advance(24 * hour);
  f.updates.resume();
  expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
  await f.check();
  expect(f.updater.downloadUpdate).toHaveBeenCalledOnce();
  expect((await f.state()).status).toBe('ready');
  f.updates.setAutomatic(true);
  await f.advance(6 * hour);
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  f.updates.setAutomatic(false);
  await f.advance(12 * hour);
  f.updates.resume();
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
});

it('turning off before the startup timer prevents the first check', async () => {
  const f = fixture();
  await f.advance(10_000);
  f.updates.setAutomatic(false);
  await f.advance(60_000);
  expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
  f.updates.setAutomatic(true);
  await f.advance(0);
  expect(f.updater.checkForUpdates).toHaveBeenCalledOnce();
});

it('returns null without awaiting the check or download and serializes both phases', async () => {
  const f = fixture();
  const check = deferred<UpdateCheckResult>();
  const download = deferred<string[]>();
  f.updater.checkForUpdates.mockReturnValue(check.promise);
  f.updater.downloadUpdate.mockReturnValue(download.promise);
  expect(await f.check()).toBeNull();
  expect((await f.state()).status).toBe('checking');
  await f.check();
  await f.advance(10_000);
  expect(f.updater.checkForUpdates).toHaveBeenCalledOnce();
  check.resolve(result());
  await flush();
  expect((await f.state()).status).toBe('downloading');
  await f.check();
  await f.advance(10_000);
  f.updates.resume();
  expect(f.updater.checkForUpdates).toHaveBeenCalledOnce();
  expect(f.updater.downloadUpdate).toHaveBeenCalledOnce();
  download.resolve(['update']);
  await flush();
  expect((await f.state()).status).toBe('ready');
});

it('installs on quit and notifies once per version, with plain text notes', async () => {
  const f = fixture();
  f.updater.checkForUpdates.mockResolvedValue(result());
  await f.check();
  expect(f.updater.autoDownload).toBe(false);
  expect(f.updater.autoInstallOnAppQuit).toBe(true);
  expect(await f.state()).toEqual({ current: '0.1.0', status: 'ready', version: '0.2.0',
    notes: 'New & improved' });
  expect(f.notify).toHaveBeenCalledWith({ title: '新版本已备好',
    body: 'v0.2.0 · 退出时自动安装，也可以在设置里立即重启' }, expect.anything());
  await f.check();
  expect(f.notify).toHaveBeenCalledOnce();
  f.updater.checkForUpdates.mockResolvedValue(result(true, { ...info, version: '0.3.0' }));
  await f.check();
  expect(f.notify).toHaveBeenCalledTimes(2);
  expect(await f.apply()).toBeNull();
  expect(f.quitToInstall).not.toHaveBeenCalled();
  await f.advance(0);
  expect(f.quitToInstall).toHaveBeenCalledOnce();
});

it('only checks in manual mode and opens the exact repository release URL', async () => {
  const f = fixture('manual');
  f.updater.checkForUpdates.mockResolvedValue(result());
  await f.check();
  expect(await f.state()).toEqual({ current: '0.1.0', status: 'manual', version: '0.2.0',
    notes: 'New & improved', url: 'https://github.com/muyuzhong/Featherlog/releases/tag/v0.2.0' });
  expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
  expect(f.updater.autoInstallOnAppQuit).toBe(false);
  expect(f.notify).not.toHaveBeenCalled();
  expect(await f.apply()).toBeNull();
  expect(f.openExternal).toHaveBeenCalledExactlyOnceWith(
    'https://github.com/muyuzhong/Featherlog/releases/tag/v0.2.0');
  expect(f.quitToInstall).not.toHaveBeenCalled();
});

it('cannot navigate to a URL or path injected through a release version', async () => {
  const f = fixture('manual');
  f.updater.checkForUpdates.mockResolvedValue(result(true, { ...info,
    version: '../../evil?url=https://evil.test/#' }));
  await f.check();
  await f.apply();
  expect(f.openExternal).toHaveBeenCalledWith(
    'https://github.com/muyuzhong/Featherlog/releases/tag/v..%2F..%2Fevil%3Furl%3Dhttps%3A%2F%2Fevil.test%2F%23');
});

it('rejects apply in every state without an applicable update', async () => {
  const f = fixture();
  const reject = () => expect(f.apply()).rejects.toMatchObject({ code: 'shell/no-update' });
  await reject();
  await f.check();
  expect((await f.state()).status).toBe('latest');
  await reject();
  const check = deferred<UpdateCheckResult>();
  const download = deferred<string[]>();
  f.updater.checkForUpdates.mockReturnValue(check.promise);
  f.updater.downloadUpdate.mockReturnValue(download.promise);
  await f.check();
  expect((await f.state()).status).toBe('checking');
  await reject();
  check.resolve(result());
  await flush();
  expect((await f.state()).status).toBe('downloading');
  await reject();
  download.reject(new Error('checksum mismatch'));
  await flush();
  expect((await f.state()).status).toBe('error');
  await reject();
  expect(f.quitToInstall).not.toHaveBeenCalled();
  expect(f.openExternal).not.toHaveBeenCalled();
});

it('logs errors without notifications, releases the lock, and retries on schedule', async () => {
  const f = fixture();
  f.updater.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
  await f.advance(30_000);
  expect(await f.state()).toEqual({ current: '0.1.0', status: 'error', message: 'offline',
    checkedAt: '1970-01-01T00:00:30.000Z' });
  expect(f.log.error).toHaveBeenCalledOnce();
  expect(f.notify).not.toHaveBeenCalled();
  await f.advance(5 * 60_000);
  expect((await f.state()).status).toBe('latest');
  f.updater.checkForUpdates.mockResolvedValueOnce(null);
  await f.check();
  expect((await f.state()).status).toBe('error');
});

it.each(['resolve', 'reject'] as const)('recovers a hung check and ignores its late %s', async late => {
  const f = fixture();
  const hanging = deferred<UpdateCheckResult>();
  f.updater.checkForUpdates.mockReturnValue(hanging.promise);
  await f.check();
  await f.advance(119_999);
  expect((await f.state()).status).toBe('checking');
  await f.advance(1);
  expect((await f.state()).status).toBe('error');
  expect(f.updater.autoInstallOnAppQuit).toBe(false);
  await f.check();
  expect(f.createUpdater).toHaveBeenCalledTimes(2);
  const recovered = await f.state();
  expect(recovered.status).toBe('latest');
  f.updater.emit('error', new Error('late event'));
  if (late === 'resolve') hanging.resolve(result());
  else hanging.reject(new Error('late rejection'));
  await flush();
  expect(await f.state()).toEqual(recovered);
  expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
  expect(f.notify).not.toHaveBeenCalled();
  expect(f.log.error).toHaveBeenCalledOnce();
});

it('cancels a stalled download and ignores old progress and completion during a retry', async () => {
  const f = fixture();
  const hanging = deferred<string[]>();
  const cancellationToken = { cancel: vi.fn() } as unknown as NonNullable<UpdateCheckResult['cancellationToken']>;
  f.updater.checkForUpdates.mockResolvedValue({ ...result(), cancellationToken });
  f.updater.downloadUpdate.mockReturnValue(hanging.promise);
  await f.check();
  expect(f.updater.downloadUpdate).toHaveBeenCalledWith(cancellationToken);
  await f.advance(120_000);
  expect(cancellationToken.cancel).toHaveBeenCalledOnce();
  expect(f.updater.autoInstallOnAppQuit).toBe(false);
  const next = new FakeUpdater();
  next.checkForUpdates.mockResolvedValue(result());
  const download = deferred<string[]>();
  next.downloadUpdate.mockReturnValue(download.promise);
  f.createUpdater.mockReturnValueOnce(next);
  await f.check();
  f.updater.emit('download-progress', { percent: 100 });
  f.updater.emit('error', new Error('late download error'));
  hanging.resolve(['stale']);
  await flush();
  expect(await f.state()).toMatchObject({ status: 'downloading', percent: 0 });
  expect(f.notify).not.toHaveBeenCalled();
  download.resolve(['new']);
  await flush();
  expect((await f.state()).status).toBe('ready');
  expect(f.notify).toHaveBeenCalledOnce();
});

it('allows long downloads with advancing progress, but repeated progress cannot mask a stall', async () => {
  const f = fixture();
  f.updater.checkForUpdates.mockResolvedValue(result());
  f.updater.downloadUpdate.mockReturnValue(new Promise(() => {}));
  await f.check();
  for (const percent of [10, 20, 30]) {
    await f.advance(119_000);
    f.updater.emit('download-progress', { percent });
  }
  expect((await f.state()).status).toBe('downloading');
  await f.advance(119_999);
  f.updater.emit('download-progress', { percent: 30 });
  await f.advance(1);
  expect((await f.state()).status).toBe('error');
});

it('backs off failures at 5m, 15m, 1h, 6h and resets after success', async () => {
  const f = fixture();
  f.updater.checkForUpdates.mockRejectedValue(new Error('offline'));
  await f.check();
  let calls = 1;
  for (const delay of [5 * 60_000, 15 * 60_000, hour, 6 * hour, 6 * hour]) {
    await f.advance(delay - 1);
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(calls);
    await f.advance(1);
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(++calls);
  }
  f.updater.checkForUpdates.mockResolvedValueOnce(result(false));
  await f.check();
  await f.advance(6 * hour - 1);
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(++calls);
  await f.advance(1);
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(++calls);
  await f.advance(5 * 60_000);
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(++calls);
});

it('retries a failed check on resume and suppresses automatic retries when disabled', async () => {
  const f = fixture();
  f.updater.checkForUpdates.mockRejectedValue(new Error('offline'));
  await f.check();
  f.updates.resume();
  await flush();
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  f.updates.setAutomatic(false);
  f.updates.resume();
  await f.advance(12 * hour);
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  expect(f.timers.size).toBe(0);
  f.updater.checkForUpdates.mockResolvedValue(result(false));
  await f.check();
  expect((await f.state()).status).toBe('latest');
});

it('throttles progress to 500 ms, bounds percentages and always sends the final state', async () => {
  const f = fixture();
  const download = deferred<string[]>();
  f.updater.checkForUpdates.mockResolvedValue(result());
  f.updater.downloadUpdate.mockReturnValue(download.promise);
  await f.check();
  const progress = (percent: number) => f.updater.emit('download-progress', { percent });
  progress(1);
  await f.advance(499);
  progress(10);
  await f.advance(1);
  progress(20);
  progress(21);
  await f.advance(499);
  progress(30);
  await f.advance(1);
  progress(NaN);
  progress(101);
  await flush();
  expect(f.changes.filter(state => state.status === 'downloading').map(state => state.percent))
    .toEqual([0, 20, 100]);
  download.resolve(['update']);
  await flush();
  expect(f.changes.at(-1)?.status).toBe('ready');
  progress(50);
  expect((await f.state()).status).toBe('ready');
});

it('disposes timers, responders and listeners and ignores in-flight completion', async () => {
  const f = fixture();
  const download = deferred<string[]>();
  f.updater.checkForUpdates.mockResolvedValue(result());
  f.updater.downloadUpdate.mockReturnValue(download.promise);
  await f.check();
  f.updates.dispose();
  const count = f.changes.length;
  download.resolve(['update']);
  await flush();
  await f.advance(24 * hour);
  f.updates.resume();
  expect(f.changes).toHaveLength(count);
  expect(f.notify).not.toHaveBeenCalled();
  expect(f.timers.size).toBe(0);
  expect(f.updater.listenerCount('download-progress')).toBe(0);
  await expect(f.state()).rejects.toMatchObject({ code: 'no-handler' });
});

it('turns HTML notes into bounded plain text, including changelog arrays and entities', () => {
  expect(releaseNotes(undefined)).toBe('');
  expect(releaseNotes(null)).toBe('');
  expect(releaseNotes('<script>alert(1)</script><style>p{}</style><p>你好<br>世界</p>'))
    .toBe('你好\n世界');
  expect(releaseNotes([{ version: '2', note: '<b>Two</b>' }, { version: '1', note: 'One' }]))
    .toBe('Two\nOne');
  expect(releaseNotes('&lt;b&gt;&quot;&#39;&#x1f600;&nbsp;&#999999999;'))
    .toBe('<b>"\'😀');
  expect(Array.from(releaseNotes('字😀'.repeat(2000)))).toHaveLength(2000);
});

it('remembers notified versions across launches', async () => {
  const first = fixture();
  first.updater.checkForUpdates.mockResolvedValue(result());
  await first.check();
  expect(first.saveNotified).toHaveBeenCalledExactlyOnceWith(['0.2.0']);
  first.updates.dispose();
  const restarted = fixture('automatic', true, ['0.2.0']);
  restarted.updater.checkForUpdates.mockResolvedValue(result());
  await restarted.check();
  expect((await restarted.state()).status).toBe('ready');
  expect(restarted.notify).not.toHaveBeenCalled();
});

it('logs notification and history failures without losing a downloaded update', async () => {
  const f = fixture();
  f.updater.checkForUpdates.mockResolvedValue(result());
  f.saveNotified.mockRejectedValueOnce(new Error('disk full'));
  f.notify.mockImplementationOnce(() => { throw new Error('notification failed'); });
  await f.check();
  expect((await f.state()).status).toBe('ready');
  expect(f.log.error).toHaveBeenCalledTimes(2);
  await f.check();
  expect(f.notify).toHaveBeenCalledOnce();
});

it('deduplicates error events and rejected checks', async () => {
  const f = fixture();
  f.updater.checkForUpdates.mockImplementationOnce(async () => {
    const error = new Error('offline');
    f.updater.emit('error', error);
    throw error;
  });
  await f.check();
  expect(f.changes.filter(state => state.status === 'error')).toHaveLength(1);
  expect(f.log.error).toHaveBeenCalledOnce();
});

it.each([
  [false, 'linux', undefined, false],
  [true, 'linux', '/app.AppImage', false],
  [true, 'win32', undefined, true],
  [true, 'darwin', undefined, false],
] as const)('managed takes precedence over %s %s %s %s', (packaged, platform, image, nsis) => {
  expect(updateMode(packaged, platform, image, nsis, true)).toBe('managed');
});
