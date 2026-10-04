import { app, ipcMain, Menu, screen } from 'electron';
import { join } from 'node:path';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import type { Clock, WindowKind } from '@featherlog/contracts';
import { createKernel } from '@featherlog/kernel';
import { plugins } from './plugins';
import { JsonFiles, pluginStorage } from './storage';
import { loadSettings } from './settings';
import { Secrets, registerSecretIpc } from './secrets';
import { createLogs } from './log';
import { createBusBridge } from './bridge';
import { ElectronFloat, PlainFloat, selectDock } from './dock';
import { createKWinFloat } from './kwin-float';
import { registerShell } from './shell-state';
import { Windows } from './windows';
import { startUpdates } from './electron-updates';
import { configureUserData } from './user-data';
import { invalid, isJson } from './validation';
import { loadPlugins, showStartupError } from './startup';

const clock: Clock = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

// The lock and every service must use the final directory, including migration fallback.
const { migrationError } = configureUserData(app);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Frameless windows use their own menus; macOS still needs native editing shortcuts.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  const userData = app.getPath('userData');
  const files = new JsonFiles(clock);
  const logs = createLogs(userData, clock);
  const log = logs.logger('shell');
  if (migrationError !== undefined) {
    log.warn('Could not migrate legacy user data', migrationError);
  }
  let shutdown = async () => {};
  let installUpdate: (() => void) | undefined;
  let stopUpdates = () => {};
  let stopped = false;
  let quitting = false;
  let openPanel = () => { pendingOpen = true; };
  let pendingOpen = false;
  app.on('second-instance', () => openPanel());
  app.on('activate', () => openPanel());
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (stopped) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void shutdown().catch(cause => log.error('Shutdown failed', cause)).finally(async () => {
      await files.flush();
      await logs.flush();
      stopped = true;
      if (installUpdate) installUpdate();
      else app.quit();
    });
  });

  const start = async () => {
    // This read must remain synchronous: compatibility switches precede Electron's ready event.
    const settings = loadSettings(userData, plugins.map(plugin => plugin.manifest), files, log, clock);
    const secrets = new Secrets(userData, settings, files, log);
    const compatMode = process.env.FEATHERLOG_COMPAT_MODE === '1' ||
      settings.all().shell!.compatMode === true;
    if (compatMode) app.commandLine.appendSwitch('ozone-platform', 'x11');
    const selected = selectDock(process.platform, process.env.WAYLAND_DISPLAY,
      process.env.XDG_CURRENT_DESKTOP ?? '', compatMode,
      app.commandLine.getSwitchValue('ozone-platform'));
    const dock = selected === 'electron'
      ? new ElectronFloat(screen, files, join(userData, 'float.json'), clock, log)
      : selected === 'kwin' ? await createKWinFloat(userData, log) : new PlainFloat();
    const kernel = createKernel({
      development: !app.isPackaged, clock, log,
      createServices: id => ({ clock, log: logs.logger(id),
        storage: pluginStorage(userData, id, files), settings: settings.forPlugin(id),
        secrets: secrets.forPlugin(id) }),
    });
    kernel.observe(message => {
      if (message.kind === 'event' && message.type.startsWith('kernel/')) {
        if (message.type === 'kernel/plugin-failed') log.error(message.type, message.payload);
        else log.info(message.type, message.payload);
      }
    });
    const bus = kernel.createBus('shell');
    let windows: Windows;
    const shell = registerShell(bus, () => windows.openPanel(), clock, () => app.quit());
    const bridge = createBusBridge(kernel, log, !app.isPackaged);
    const peers = new Map<WebContents, WindowKind>();
    const register = (window: BrowserWindow, kind: WindowKind) => {
      const peer = window.webContents;
      peers.set(peer, kind);
      bridge.register(peer);
      peer.once('destroyed', () => peers.delete(peer));
    };
    const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
      peers.has(event.sender) && event.senderFrame === event.sender.mainFrame;
    for (const channel of ['bus:send', 'bus:subscribe', 'bus:unsubscribe']) {
      ipcMain.on(channel, (event, payload: unknown) => {
        if (trusted(event)) bridge.receive(event.sender, channel, payload);
      });
    }
    ipcMain.handle('settings:all', event => {
      if (!trusted(event)) invalid('Unknown settings sender');
      return settings.all();
    });
    ipcMain.handle('settings:set', async (event, scope: unknown, key: unknown, value: unknown) => {
      try {
        if (!trusted(event) || typeof scope !== 'string' || typeof key !== 'string' || !isJson(value)) {
          invalid('Invalid setting request', 'shell/invalid-setting');
        }
        await settings.set(scope, key, value);
        return {};
      } catch (cause) {
        return { error: {
          code: cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
            ? cause.code : 'shell/settings-error',
          message: cause instanceof Error ? cause.message : String(cause),
        } };
      }
    });
    registerSecretIpc(ipcMain, secrets, trusted);
    const offSettings = settings.onChange((scope, key, value) => {
      for (const peer of peers.keys()) {
        if (!peer.isDestroyed()) peer.send('settings:changed', scope, key, value);
      }
    });
    ipcMain.handle('dock:side', event => {
      if (!trusted(event) || peers.get(event.sender) !== 'collapsed') {
        invalid('Dock direction is only available to the collapsed window');
      }
      return dock.side;
    });
    ipcMain.on('dock:resize', (event, size: unknown) => {
      if (trusted(event) && peers.get(event.sender) === 'collapsed') windows.resize(size);
    });
    ipcMain.on('dock:menu', event => {
      if (trusted(event) && peers.get(event.sender) === 'collapsed') windows.menu();
    });
    ipcMain.on('panel:close', event => {
      if (trusted(event) && peers.get(event.sender) === 'panel') windows.closePanel();
    });
    windows = new Windows(dock, files, userData, clock, log, register, shell.view,
      showSettings => {
        void bus.request('shell/open-panel', showSettings ? { tab: 'shell/settings' } : {})
          .catch(cause => log.error('Could not open panel', cause));
      });
    shutdown = async () => {
      stopUpdates();
      for (const plugin of [...plugins].reverse()) kernel.unload(plugin.manifest.id);
      bridge.dispose();
      offSettings();
      shell.dispose();
      try { await windows.stop(); }
      finally { await Promise.all([settings.flush(), secrets.flush()]); }
    };
    await app.whenReady();
    if (quitting) return;
    stopUpdates = startUpdates(bus, clock, log, settings, files, install => {
      installUpdate = install;
      app.quit();
    });
    if (process.platform === 'darwin') app.dock?.hide();
    log.info('Starting Featherlog', { platform: process.platform, compatMode, selected });
    await loadPlugins(kernel, plugins, app.getVersion(), userData);
    if (quitting) return;
    await windows.start();
    openPanel = () => {
      void bus.request('shell/open-panel', {}).catch(cause => log.error('Could not open panel', cause));
    };
    if (pendingOpen) openPanel();
  };
  void start().catch(async (cause: unknown) => {
    log.error('Startup failed', cause);
    try {
      // On Linux, error boxes shown before ready only reach stderr.
      await app.whenReady();
      const details = cause instanceof Error
        ? `${'code' in cause && typeof cause.code === 'string' ? `${cause.code}: ` : ''}${cause.message}`
        : String(cause);
      showStartupError('羽记启动失败', details, app.getVersion(), userData);
    } finally {
      app.quit();
    }
  });
}
