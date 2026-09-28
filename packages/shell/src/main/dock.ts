import type { BrowserWindow, Display, Rectangle } from 'electron';
import type { Clock, DockCapabilities, Logger } from '@featherlog/contracts';
import type { JsonFiles } from './storage';
import { record } from './validation';

export interface Dock {
  readonly capabilities: DockCapabilities;
  attach(window: BrowserWindow): Promise<void>;
  resize(size: { width: number; height: number }): void;
  detach(): Promise<void>;
}

export function selectDock(platform: string, waylandDisplay: string | undefined,
  desktop: string, compatMode: boolean, ozonePlatform = ''): 'electron' | 'kwin' | 'plain' {
  if (platform !== 'linux' || !waylandDisplay || compatMode || ozonePlatform === 'x11') {
    return 'electron';
  }
  return desktop.toUpperCase().includes('KDE') ? 'kwin' : 'plain';
}

export function rightmostDisplay(displays: Display[]): Display {
  return displays.reduce((best, display) =>
    display.bounds.x + display.bounds.width > best.bounds.x + best.bounds.width ? display : best);
}

export function defaultBounds(area: Rectangle, size: { width: number; height: number }): Rectangle {
  return { x: area.x + area.width - size.width,
    y: Math.round(area.y + (area.height - size.height) / 2), ...size };
}

export function resizedBounds(previous: Rectangle, size: { width: number; height: number },
  area: Rectangle): Rectangle {
  return {
    x: Math.round(Math.max(area.x, Math.min(previous.x + previous.width - size.width,
      area.x + area.width - size.width))),
    y: Math.round(Math.max(area.y, Math.min(previous.y, area.y + area.height - size.height))),
    ...size,
  };
}

export class ElectronFloat implements Dock {
  readonly capabilities = { anchored: false, keepAbove: true, focusSafe: true };
  private window?: BrowserWindow;
  private cancelSave = () => {};
  private dirty = false;
  constructor(
    private screen: Pick<Electron.Screen, 'getAllDisplays' | 'getDisplayMatching'>,
    private files: JsonFiles,
    private file: string,
    private clock: Clock,
    private log: Logger,
  ) {}

  private save = async () => {
    if (!this.dirty || !this.window || this.window.isDestroyed()) return;
    this.dirty = false;
    const { x, y } = this.window.getBounds();
    await this.files.write(this.file, { x, y });
  };
  private moved = () => {
    this.dirty = true;
    this.cancelSave();
    this.cancelSave = this.clock.setTimeout(() => {
      void this.save().catch(cause => this.log.error('Float position save failed', cause));
    }, 150);
  };

  async attach(window: BrowserWindow): Promise<void> {
    this.window = window;
    const displays = this.screen.getAllDisplays();
    const { width, height } = window.getBounds();
    const saved = await this.files.read(this.file);
    let bounds = defaultBounds(rightmostDisplay(displays).bounds, { width, height });
    if (record(saved) && typeof saved.x === 'number' && typeof saved.y === 'number' &&
      displays.some(({ bounds: area }) => Number(saved.x) >= area.x &&
        Number(saved.x) < area.x + area.width && Number(saved.y) >= area.y &&
        Number(saved.y) < area.y + area.height)) {
      bounds = { x: saved.x, y: saved.y, width, height };
    }
    window.setAlwaysOnTop(true, 'floating');
    window.setBounds(bounds);
    window.on('moved', this.moved);
  }
  resize(size: { width: number; height: number }): void {
    if (!this.window || this.window.isDestroyed()) return;
    const previous = this.window.getBounds();
    this.window.setBounds(resizedBounds(previous, size,
      this.screen.getDisplayMatching(previous).bounds));
  }
  async detach(): Promise<void> {
    this.cancelSave();
    this.window?.removeListener('moved', this.moved);
    try { await this.save(); }
    finally { this.window = undefined; }
  }
}

export class PlainFloat implements Dock {
  readonly capabilities: DockCapabilities = { anchored: false, keepAbove: false, focusSafe: false };
  private window?: BrowserWindow;
  async attach(window: BrowserWindow): Promise<void> { this.window = window; }
  resize(size: { width: number; height: number }): void {
    if (this.window && !this.window.isDestroyed()) this.window.setSize(size.width, size.height);
  }
  async detach(): Promise<void> { this.window = undefined; }
}
