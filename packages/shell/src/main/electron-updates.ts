import { app, powerMonitor, shell } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppUpdater } from 'electron-updater';
import type { Bus, Clock, Logger } from '@featherlog/contracts';
import { Settings } from './settings';
import { JsonFiles, readJsonSync } from './storage';
import { registerUpdates, updateMode } from './updates';
import { configureUpdateNetwork } from './update-network';

export function startUpdates(bus: Bus, clock: Clock, log: Logger, settings: Settings,
  files: JsonFiles, quitToInstall: (install: () => void) => void) {
  const mode = updateMode(app.isPackaged, process.platform, process.env.APPIMAGE,
    existsSync(join(dirname(process.execPath), 'Uninstall Featherlog.exe')),
    existsSync(join(process.resourcesPath, 'package-type')));
  let updater: AppUpdater | undefined;
  const createUpdater = async () => {
    const { default: electronUpdater } = await import('electron-updater');
    updater = process.platform === 'linux' ? new electronUpdater.AppImageUpdater() : process.platform === 'darwin'
      ? new electronUpdater.MacUpdater() : new electronUpdater.NsisUpdater();
    updater.logger = log;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.isUserWithinRollout = () => true;
    // Non-AppImage Linux installs can query the same metadata, but never download or install it.
    if (mode === 'manual') updater.isUpdaterActive = () => app.isPackaged;
    updater.setFeedURL({ provider: 'github', owner: 'muyuzhong', repo: 'Featherlog' });
    configureUpdateNetwork(updater.netSession);
    return updater;
  };
  const historyPath = join(app.getPath('userData'), 'updates.json');
  let notifiedVersions: string[] = [];
  try {
    const saved = readJsonSync(historyPath);
    if (Array.isArray(saved) && saved.every(item => typeof item === 'string')) {
      notifiedVersions = saved;
    }
  } catch (cause) {
    log.warn('Could not read update notification history', cause);
  }
  const updates = registerUpdates({ bus, clock, log, mode, createUpdater,
    notifiedVersions, saveNotified: versions => files.write(historyPath, versions),
    current: app.getVersion(), automatic: settings.all().shell!.autoUpdate === true,
    openExternal: url => shell.openExternal(url),
    quitToInstall: () => quitToInstall(() => updater!.quitAndInstall(false, true)),
  });
  const offSettings = settings.onChange((scope, key, value) => {
    if (scope === 'shell' && key === 'autoUpdate') updates.setAutomatic(value === true);
  });
  powerMonitor.on('resume', updates.resume);
  return () => {
    offSettings();
    powerMonitor.removeListener('resume', updates.resume);
    updates.dispose();
  };
}
