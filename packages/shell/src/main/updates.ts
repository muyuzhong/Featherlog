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
  updater?: Updater;
  automatic: boolean;
  notifiedVersions: string[];
  saveNotified: (versions: string[]) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  quitToInstall: () => void;
}) {
  const { bus, clock, log, current, mode, updater } = options;
  const offline = mode === 'unsupported' || mode === 'managed';
  let state: UpdateState = { current, status: offline ? mode : 'idle' };
  let automatic = options.automatic;
  let busy = false;
  let disposed = false;
  let lastCheck: number | undefined;
  let progressAt = -Infinity;
  let timer: Dispose = () => {};
  let quitTimer: Dispose = () => {};
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
    if (state.status !== 'downloading' || !Number.isFinite(info.percent) ||
      clock.now() - progressAt < 500) return;
    progressAt = clock.now();
    changed({ ...state, percent: Math.max(0, Math.min(100, info.percent)) });
  };
  const schedule = () => {
    timer();
    if (disposed || !automatic || offline) return;
    const due = lastCheck === undefined ? startedAt + 30_000 : lastCheck + interval;
    timer = clock.setTimeout(() => {
      check();
      // A long download still needs a future check, without spinning an overdue timer.
      if (busy) timer = clock.setTimeout(schedule, interval);
    }, Math.max(0, due - clock.now()));
  };
  const run = async () => {
    const result = await updater!.checkForUpdates();
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
    changed({ current, status: 'downloading', version, percent: 0 });
    await updater!.downloadUpdate();
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
    lastCheck = clock.now();
    changed({ current, status: 'checking' });
    void run().catch(fail).finally(() => {
      busy = false;
      schedule();
    });
  };
  if (!offline) {
    if (!updater) throw new Error('Packaged updates require an updater');
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = mode === 'automatic';
    updater.on('error', fail);
    updater.on('download-progress', progress);
  }
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
      if (automatic && clock.now() - (lastCheck ?? startedAt) > interval) check();
    },
    dispose() {
      disposed = true;
      timer();
      quitTimer();
      for (const handler of handlers) handler();
      updater?.removeListener('error', fail);
      updater?.removeListener('download-progress', progress);
    },
  };
}
