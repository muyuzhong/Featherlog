import { app, ipcMain } from 'electron';
import { join } from 'node:path';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import type { Clock, WindowKind } from '@featherlog/contracts';
import { createKernel } from '@featherlog/kernel';
import { plugins } from './plugins';
import { JsonFiles, pluginStorage, readJsonSync } from './storage';
import { Settings } from './settings';
import { createLogs } from './log';
import { createBusBridge } from './bridge';
import { ElectronDock, FloatingDock, selectDock } from './dock';
import { registerShell } from './shell-state';
import { Windows } from './windows';
import { invalid, isJson } from './validation';

const clock: Clock = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const userData = app.getPath('userData');
  const files = new JsonFiles();
  const logs = createLogs(userData, clock);
  const log = logs.logger('shell');
  let shutdown = async () => {};
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
      app.quit();
    });
  });

  const start = async () => {
    // This read must remain synchronous: compatibility switches precede Electron's ready event.
    const settings = new Settings(userData, plugins.map(plugin => plugin.manifest),
      readJsonSync(join(userData, 'settings.json')), files, log);
    const compatMode = process.env.FEATHERLOG_COMPAT_MODE === '1' ||
      settings.all().shell!.compatMode === true;
    if (compatMode) app.commandLine.appendSwitch('ozone-platform', 'x11');
    const selected = selectDock(process.platform, process.env.WAYLAND_DISPLAY,
      process.env.XDG_CURRENT_DESKTOP ?? '', compatMode,
      app.commandLine.getSwitchValue('ozone-platform'));
    if (selected === 'kwin') log.warn('KWinDock is not implemented yet; using FloatingDock');
    const dock = selected === 'electron' ? new ElectronDock() : new FloatingDock();
    const kernel = createKernel({
      development: !app.isPackaged, clock, log,
      createServices: id => ({ clock, log: logs.logger(id),
        storage: pluginStorage(userData, id, files), settings: settings.forPlugin(id) }),
    });
    kernel.observe(message => {
      if (message.kind === 'event' && message.type.startsWith('kernel/')) {
        log.info(message.type, message.payload);
      }
    });
    const bus = kernel.createBus('shell');
    let windows: Windows;
    const shell = registerShell(bus, () => windows.openPanel());
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
    const offSettings = settings.onChange((scope, key, value) => {
      for (const peer of peers.keys()) {
        if (!peer.isDestroyed()) peer.send('settings:changed', scope, key, value);
      }
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
    windows = new Windows(dock, settings, files, userData, clock, log, register, shell.view,
      showSettings => {
        void bus.request('shell/open-panel', showSettings ? { tab: 'shell/settings' } : {})
          .catch(cause => log.error('Could not open panel', cause));
      });
    shutdown = async () => {
      for (const plugin of [...plugins].reverse()) kernel.unload(plugin.manifest.id);
      bridge.dispose();
      offSettings();
      shell.dispose();
      try { await windows.stop(); }
      finally { await settings.flush(); }
    };
    await app.whenReady();
    if (quitting) return;
    if (process.platform === 'darwin') app.dock?.hide();
    log.info('Starting Featherlog', { platform: process.platform, compatMode, selected });
    await kernel.load(plugins);
    if (quitting) return;
    await windows.start();
    openPanel = () => {
      void bus.request('shell/open-panel', {}).catch(cause => log.error('Could not open panel', cause));
    };
    if (pendingOpen) openPanel();
  };
  void start().catch(cause => {
    log.error('Startup failed', cause);
    app.quit();
  });
}
