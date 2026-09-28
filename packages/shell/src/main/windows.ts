import { app, BrowserWindow, Menu, screen } from 'electron';
import { join } from 'node:path';
import type { Clock, Logger, WindowKind } from '@featherlog/contracts';
import type { Dock, Placement } from './dock';
import { selectDisplay } from './dock';
import type { Settings } from './settings';
import type { JsonFiles } from './storage';
import { record } from './validation';

export class Windows {
  collapsed?: BrowserWindow;
  panel?: BrowserWindow;
  private panelLoading?: Promise<void>;
  private expanded = false;
  private quitting = false;
  private saveTimer = () => {};
  private disposers: Array<() => void> = [];

  constructor(
    private dock: Dock,
    private settings: Settings,
    private files: JsonFiles,
    private userData: string,
    private clock: Clock,
    private log: Logger,
    private register: (window: BrowserWindow, kind: WindowKind) => void,
    private view: (view: 'collapsed' | 'preview') => void,
    private openRequest: (settings: boolean) => void,
  ) {}

  placement(): Placement {
    const values = this.settings.all().shell!;
    const edge = values.edge as 'left' | 'right';
    return {
      edge,
      display: selectDisplay(screen.getAllDisplays(), edge, String(values.display)),
      verticalPosition: Number(values.verticalPosition),
    };
  }

  private create(kind: WindowKind, bounds: Electron.Rectangle): BrowserWindow {
    const collapsed = kind === 'collapsed';
    const window = new BrowserWindow({
      ...(collapsed && !this.dock.capabilities.anchored
        ? { width: bounds.width, height: bounds.height } : bounds),
      show: false, frame: false, transparent: collapsed,
      backgroundColor: collapsed ? '#00000000' : '#1f150d',
      title: collapsed ? 'featherlog-dock' : '羽记',
      resizable: !collapsed, skipTaskbar: collapsed, hasShadow: !collapsed,
      ...(collapsed ? {} : { minWidth: 960, minHeight: 640 }),
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
        additionalArguments: [
          `--featherlog-window=${kind}`,
          `--featherlog-dock=${this.dock.capabilities.anchored ? 'electron' : 'floating'}`,
        ],
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('preload-error', (_, path, cause) => this.log.error(`Preload ${path}`, cause));
    window.webContents.on('did-fail-load', (_, code, message) => this.log.error('Page failed', {
      kind, code, message,
    }));
    if (collapsed) {
      window.on('page-title-updated', event => event.preventDefault());
      window.webContents.on('context-menu', () => this.menu());
      if (process.platform === 'darwin') {
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
    }
    this.register(window, kind);
    return window;
  }

  private load(window: BrowserWindow, kind: WindowKind): Promise<void> {
    const server = process.env.ELECTRON_RENDERER_URL;
    if (server) {
      const url = new URL(server);
      url.searchParams.set('window', kind);
      return window.loadURL(url.toString());
    }
    return window.loadFile(join(import.meta.dirname, '../renderer/index.html'), {
      query: { window: kind },
    });
  }

  async start(): Promise<void> {
    const placement = this.placement();
    this.collapsed = this.create('collapsed', {
      x: placement.display.workArea.x, y: placement.display.workArea.y, width: 80, height: 320,
    });
    await this.dock.attach(this.collapsed, placement);
    await this.load(this.collapsed, 'collapsed');
    if (this.quitting) return;
    this.collapsed.showInactive();
    this.log.info('Collapsed window ready', {
      bounds: this.collapsed.getBounds(), display: placement.display.id,
      workArea: placement.display.workArea, capabilities: this.dock.capabilities,
    });
    const place = () => {
      void this.dock.place(this.placement()).catch(cause => this.log.error('Dock placement failed', cause));
    };
    screen.on('display-added', place);
    screen.on('display-removed', place);
    screen.on('display-metrics-changed', place);
    this.disposers.push(() => {
      screen.removeListener('display-added', place);
      screen.removeListener('display-removed', place);
      screen.removeListener('display-metrics-changed', place);
    });
    this.disposers.push(this.settings.onChange((scope, key) => {
      if (scope === 'shell' && ['edge', 'display', 'verticalPosition'].includes(key)) place();
    }));
  }

  async openPanel(): Promise<void> {
    if (this.quitting) return;
    if (!this.panelLoading) {
      this.panelLoading = (async () => {
        const saved = await this.files.read(join(this.userData, 'panel.json'));
        const area = this.placement().display.workArea;
        let bounds = {
          x: Math.round(area.x + (area.width - 1240) / 2),
          y: Math.round(area.y + (area.height - 800) / 2), width: 1240, height: 800,
        };
        if (record(saved) && ['x', 'y', 'width', 'height'].every(key =>
          typeof saved[key] === 'number' && Number.isFinite(saved[key])) &&
          Number(saved.width) >= 960 && Number(saved.height) >= 640) {
          bounds = { x: Number(saved.x), y: Number(saved.y),
            width: Number(saved.width), height: Number(saved.height) };
        }
        if (this.quitting) return;
        this.panel = this.create('panel', bounds);
        this.panel.on('close', event => {
          if (!this.quitting) {
            event.preventDefault();
            this.closePanel();
          }
        });
        this.panel.webContents.on('before-input-event', (event, input) => {
          if (input.key === 'Escape' && input.type === 'keyDown') {
            event.preventDefault();
            this.closePanel();
          }
        });
        const save = () => {
          this.saveTimer();
          this.saveTimer = this.clock.setTimeout(() => {
            void this.savePanel().catch(cause => this.log.error('Panel bounds save failed', cause));
          }, 150);
        };
        this.panel.on('move', save);
        this.panel.on('resize', save);
        await this.load(this.panel, 'panel');
      })().catch(cause => {
        this.panel?.destroy();
        this.panel = undefined;
        this.panelLoading = undefined;
        throw cause;
      });
    }
    await this.panelLoading;
    if (this.quitting || !this.panel || this.panel.isDestroyed()) return;
    this.panel.show();
    this.panel.focus();
    this.log.info('Panel window opened', this.panel.getBounds());
  }

  private async savePanel(): Promise<void> {
    if (this.panel && !this.panel.isDestroyed()) {
      await this.files.write(join(this.userData, 'panel.json'), { ...this.panel.getBounds() });
    }
  }

  closePanel(): void {
    this.panel?.hide();
    this.view(this.expanded ? 'preview' : 'collapsed');
  }

  resize(payload: unknown): void {
    if (!record(payload) || typeof payload.width !== 'number' ||
      typeof payload.height !== 'number' || !Number.isFinite(payload.width) ||
      !Number.isFinite(payload.height) || typeof payload.expanded !== 'boolean') {
      this.log.warn('Invalid dock resize');
      return;
    }
    this.dock.resize({ width: Math.round(Math.max(40, Math.min(720, payload.width))),
      height: Math.round(Math.max(80, Math.min(900, payload.height))) });
    if (this.expanded !== payload.expanded) {
      this.expanded = payload.expanded;
      this.view(this.expanded ? 'preview' : 'collapsed');
    }
  }

  menu(): void {
    Menu.buildFromTemplate([
      { label: '打开任务日志', click: () => this.openRequest(false) },
      { label: '设置', click: () => this.openRequest(true) },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]).popup({ window: this.collapsed });
  }

  async stop(): Promise<void> {
    this.quitting = true;
    this.saveTimer();
    for (const dispose of this.disposers) dispose();
    try { await this.savePanel(); }
    finally { await this.dock.detach(); }
  }
}
