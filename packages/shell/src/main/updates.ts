import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater';
import type { Bus, Clock, Dispose, Logger, UpdateState } from '@featherlog/contracts';
import { invalid } from './validation';

export type UpdateMode = 'automatic' | 'manual' | 'unsupported' | 'managed';
export type Updater = Pick<AppUpdater, 'checkForUpdates' | 'downloadUpdate' |
  'autoDownload' | 'autoInstallOnAppQuit'> & {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'download-progress', listener: (info: ProgressInfo) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'download-progress', listener: (info: ProgressInfo) => void): unknown;
};
const interval = 6 * 60 * 60 * 1000;
const stallTimeout = 120_000;
const releaseBase = 'https://github.com/muyuzhong/Featherlog/releases/tag/';

export function updateMode(packaged: boolean, platform: string, appImage: string | undefined,
  nsis: boolean, managed = false): UpdateMode {
  if (managed) return 'managed';
  if (!packaged) return 'unsupported';
  return (platform === 'win32' && nsis) || (platform === 'linux' && !!appImage)
    ? 'automatic' : 'manual';
}

export function releaseNotes(notes: UpdateInfo['releaseNotes']): string {
  const text = typeof notes === 'string' ? notes : notes?.map(note => note.note).join('\n') ?? '';
  return Array.from(text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\s*(?:br\s*\/?|\/p|\/div|\/li)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (entity, code: string) => {
      const named: Record<string, string> = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
      };
      if (!code.startsWith('#')) return named[code.toLowerCase()] ?? entity;
      const point = code[1]?.toLowerCase() === 'x'
        ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }).trim()).slice(0, 2000).join('');
}

export function registerUpdates(options: {
  bus: Bus;
  clock: Clock;
  log: Logger;
  current: string;
  mode: UpdateMode;
  createUpdater?: () => Updater | Promise<Updater>;
  automatic: boolean;
  notifiedVersions: string[];
  saveNotified: (versions: string[]) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  quitToInstall: () => void;
}) {
  const { bus, clock, log, current, mode } = options;
  const offline = mode === 'unsupported' || mode === 'managed';
  let state: UpdateState = { current, status: offline ? mode : 'idle' };
  let automatic = options.automatic;
  let busy = false;
  let disposed = false;
  let lastCheck: number | undefined;
  let progressAt = -Infinity;
  let progressPercent = 0;
  let timer: Dispose = () => {};
  let quitTimer: Dispose = () => {};
  let watchdog: Dispose = () => {};
  let refreshWatchdog = () => {};
  let cancelDownload = () => {};
  let updater: Updater | undefined;
  let detachUpdater = () => {};
  let failures = 0;
  let retryAt: number | undefined;
  const startedAt = clock.now();
  const notified = new Set(options.notifiedVersions);
  const changed = (next: UpdateState) => {
    if (disposed || JSON.stringify(state) === JSON.stringify(next)) return;
    state = next;
    bus.emit('shell/update-changed', state);
  };
  const fail = (cause: unknown) => {
    if (disposed) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    if (state.status === 'error' && state.message === message) return;
    log.error('Update failed', cause);
    changed({ current, status: 'error', message, checkedAt: new Date(clock.now()).toISOString() });
  };
  const progress = (info: ProgressInfo) => {
    if (state.status !== 'downloading' || !Number.isFinite(info.percent)) return;
    if (info.percent > progressPercent) {
      progressPercent = info.percent;
      refreshWatchdog();
    }
    if (clock.now() - progressAt < 500) return;
    progressAt = clock.now();
    changed({ ...state, percent: Math.max(0, Math.min(100, info.percent)) });
  };
  const schedule = () => {
    timer();
    if (disposed || busy || !automatic || offline) return;
    const due = retryAt ?? (lastCheck === undefined ? startedAt + 30_000 : lastCheck + interval);
    timer = clock.setTimeout(check, Math.max(0, due - clock.now()));
  };
  const connect = async () => {
    if (!options.createUpdater) throw new Error('Packaged updates require an updater');
    const instance = await options.createUpdater();
    if (disposed) return instance;
    instance.autoDownload = false;
    instance.autoInstallOnAppQuit = mode === 'automatic';
    const onError = (cause: Error) => { if (updater === instance) fail(cause); };
    instance.on('error', onError);
    instance.on('download-progress', progress);
    detachUpdater = () => {
      instance.removeListener('download-progress', progress);
      // A retired check can still emit errors; keep its guarded listener until GC.
      updater = undefined;
    };
    return instance;
  };
  const watched = async <T>(work: Promise<T>, instance: Updater): Promise<T> => {
    try {
      return await new Promise<T>((resolve, reject) => {
        refreshWatchdog = () => {
          watchdog();
          watchdog = clock.setTimeout(() => {
            // electron-updater caches pending promises, so retries need a fresh instance.
            instance.autoInstallOnAppQuit = false;
            detachUpdater();
            cancelDownload();
            reject(Object.assign(new Error('Update operation stalled for 120 seconds'), {
              code: 'shell/update-timeout',
            }));
          }, stallTimeout);
        };
        refreshWatchdog();
        work.then(resolve, reject);
      });
    } finally {
      watchdog();
      refreshWatchdog = () => {};
    }
  };
  const run = async () => {
    const instance = updater ?? await connect();
    if (disposed) return;
    updater = instance;
    const result = await watched(instance.checkForUpdates(), instance);
    if (disposed) return;
    if (!result) throw new Error('Update check returned no result');
    if (!result.isUpdateAvailable) {
      changed({ current, status: 'latest', checkedAt: new Date(clock.now()).toISOString() });
      return;
    }
    const { version } = result.updateInfo;
    const notes = releaseNotes(result.updateInfo.releaseNotes);
    const details = { version, ...(notes ? { notes } : {}) };
    if (mode === 'manual') {
      changed({ current, status: 'manual', ...details,
        url: releaseBase + encodeURIComponent(`v${version}`) });
      return;
    }
    progressAt = clock.now();
    progressPercent = 0;
    changed({ current, status: 'downloading', version, percent: 0 });
    cancelDownload = () => result.cancellationToken?.cancel();
    await watched(instance.downloadUpdate(result.cancellationToken), instance);
    cancelDownload = () => {};
    if (disposed) return;
    changed({ current, status: 'ready', ...details });
    if (notified.has(version)) return;
    notified.add(version);
    await options.saveNotified([...notified])
      .catch(cause => log.error('Could not save update notification history', cause));
    if (disposed) return;
    void bus.request('shell/notify', {
      title: '新版本已备好',
      body: `v${version} · 退出时自动安装，也可以在设置里立即重启`,
    }).catch(cause => log.error('Could not notify about update', cause));
  };
  const check = () => {
    if (disposed || busy || offline) return;
    busy = true;
    timer();
    lastCheck = clock.now();
    changed({ current, status: 'checking' });
    void run().then(() => {
      failures = 0;
      retryAt = undefined;
    }).catch(cause => {
      fail(cause);
      const delay = [5 * 60_000, 15 * 60_000, 60 * 60_000][failures++] ?? interval;
      retryAt = clock.now() + delay;
    }).finally(() => {
      cancelDownload = () => {};
      busy = false;
      schedule();
    });
  };
  const handlers = [
    bus.handle('shell/update-state', () => state),
    bus.handle('shell/check-update', () => { check(); return null; }),
    bus.handle('shell/apply-update', async () => {
      if (state.status === 'ready') {
        // Let the bus response settle before normal shutdown disposes its responders.
        quitTimer();
        quitTimer = clock.setTimeout(options.quitToInstall, 0);
      } else if (state.status === 'manual') {
        const expected = releaseBase + encodeURIComponent(`v${state.version}`);
        if (state.url !== expected) invalid('Invalid release URL', 'shell/no-update');
        await options.openExternal(expected);
      } else {
        invalid('No update is ready', 'shell/no-update');
      }
      return null;
    }),
  ];
  schedule();
  return {
    setAutomatic(value: boolean) { automatic = value; schedule(); },
    resume() {
      if (automatic && (state.status === 'error' ||
        clock.now() - (lastCheck ?? startedAt) > interval)) check();
    },
    dispose() {
      disposed = true;
      timer();
      quitTimer();
      watchdog();
      cancelDownload();
      for (const handler of handlers) handler();
      detachUpdater();
    },
  };
}
