import type { BrowserWindow, Display, Rectangle } from 'electron';
import type { Clock, DockCapabilities, Logger, UnfoldSide } from '@featherlog/contracts';
import type { JsonFiles } from './storage';
import { record } from './validation';

export interface Dock {
  readonly capabilities: DockCapabilities;
  readonly side: UnfoldSide;
  onSide(listener: (side: UnfoldSide) => void): () => void;
  attach(window: BrowserWindow): Promise<void>;
  resize(size: { width: number; height: number; expanded?: boolean }): void;
  detach(): Promise<void>;
}

export function unfoldSide(bounds: Rectangle, area: Rectangle): UnfoldSide {
  return bounds.x + bounds.width / 2 >= area.x + area.width / 2 ? 'left' : 'right';
}

export function sideState(initial: UnfoldSide) {
  let value = initial;
  const listeners = new Set<(side: UnfoldSide) => void>();
  return {
    get: () => value,
    set(side: UnfoldSide) {
      if (side === value) return;
      value = side;
      for (const listener of listeners) listener(side);
    },
    onChange(listener: (side: UnfoldSide) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
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
  area: Rectangle, side: UnfoldSide = 'left'): Rectangle {
  const x = side === 'left' ? previous.x + previous.width - size.width : previous.x;
  // The scroll is vertically centered; integer half-heights avoid drift across odd sizes.
  const y = previous.y + Math.floor(previous.height / 2) - Math.floor(size.height / 2);
  return {
    x: Math.round(Math.max(area.x, Math.min(x,
      area.x + area.width - size.width))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - size.height))),
    width: size.width, height: size.height,
  };
}

export class ElectronFloat implements Dock {
  readonly capabilities = { anchored: false, keepAbove: true, focusSafe: true };
  private window?: BrowserWindow;
  private cancelSave = () => {};
  private dirty = false;
  private expanded = false;
  private resizePosition?: Rectangle;
  private readonly direction = sideState('left');
  get side(): UnfoldSide { return this.direction.get(); }
  onSide = (listener: (side: UnfoldSide) => void) => this.direction.onChange(listener);
  private updateSide() {
    if (this.expanded || !this.window) return;
    const bounds = this.window.getBounds();
    this.direction.set(unfoldSide(bounds, this.screen.getDisplayMatching(bounds).bounds));
  }
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
    const bounds = this.window?.getBounds();
    if (bounds && (bounds.x !== this.resizePosition?.x || bounds.y !== this.resizePosition?.y)) {
      this.resizePosition = undefined;
      this.updateSide();
    }
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
    this.updateSide();
    window.on('moved', this.moved);
  }
  resize(size: { width: number; height: number; expanded?: boolean }): void {
    if (!this.window || this.window.isDestroyed()) return;
    const previous = this.window.getBounds();
    // Native bounds can lag behind a changed target, especially when reversing an animation.
    const sameSize = this.resizePosition?.width === size.width &&
      this.resizePosition.height === size.height;
    // Keep the direction locked through resize-generated moved events, including collapse.
    this.expanded = true;
    this.resizePosition = resizedBounds(previous, size,
      this.screen.getDisplayMatching(previous).bounds, this.side);
    if (!sameSize || previous.x !== this.resizePosition.x || previous.y !== this.resizePosition.y ||
      previous.width !== size.width || previous.height !== size.height) {
      this.window.setBounds(this.resizePosition);
    }
    this.expanded = size.expanded ?? false;
  }
  async detach(): Promise<void> {
    this.cancelSave();
    this.window?.removeListener('moved', this.moved);
    try { await this.save(); }
    finally { this.window = undefined; }
  }
}

export class PlainFloat implements Dock {
  get side(): UnfoldSide { return 'right'; }
  onSide(_listener: (side: UnfoldSide) => void): () => void { return () => {}; }
  readonly capabilities: DockCapabilities = { anchored: false, keepAbove: false, focusSafe: false };
  private window?: BrowserWindow;
  async attach(window: BrowserWindow): Promise<void> { this.window = window; }
  resize(size: { width: number; height: number; expanded?: boolean }): void {
    if (this.window && !this.window.isDestroyed()) this.window.setSize(size.width, size.height);
  }
  async detach(): Promise<void> { this.window = undefined; }
}
