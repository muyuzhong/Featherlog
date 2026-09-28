import type { BrowserWindow, Display, Rectangle } from 'electron';
import type { DockCapabilities } from '@featherlog/contracts';

export type Placement = { edge: 'left' | 'right'; display: Display; verticalPosition: number };
export interface Dock {
  readonly capabilities: DockCapabilities;
  attach(window: BrowserWindow, placement: Placement): Promise<void>;
  place(placement: Placement): Promise<void>;
  resize(size: { width: number; height: number }): void;
  detach(): Promise<void>;
}

export function selectDock(platform: string, waylandDisplay: string | undefined,
  desktop: string, compatMode: boolean, ozonePlatform = ''): 'electron' | 'kwin' | 'floating' {
  if (platform !== 'linux' || !waylandDisplay || compatMode || ozonePlatform === 'x11') {
    return 'electron';
  }
  return desktop.toUpperCase().split(/[:;]/).some(value => value.includes('KDE'))
    ? 'kwin' : 'floating';
}

export function selectDisplay(displays: Display[], edge: 'left' | 'right', id: string): Display {
  const chosen = displays.find(display => String(display.id) === id);
  if (chosen) return chosen;
  if (!displays.length) throw new Error('No display is available');
  return displays.reduce((best, display) => {
    const area = display.workArea;
    const previous = best.workArea;
    return edge === 'right'
      ? area.x + area.width > previous.x + previous.width ? display : best
      : area.x < previous.x ? display : best;
  });
}

export function anchoredBounds(placement: Placement,
  size: { width: number; height: number }): Rectangle {
  const area = placement.display.workArea;
  return {
    x: Math.round(placement.edge === 'right' ? area.x + area.width - size.width : area.x),
    y: Math.round(area.y + (area.height - size.height) * placement.verticalPosition),
    width: size.width,
    height: size.height,
  };
}

export class ElectronDock implements Dock {
  readonly capabilities = { anchored: true, keepAbove: true, focusSafe: true };
  private window?: BrowserWindow;
  private placement?: Placement;
  async attach(window: BrowserWindow, placement: Placement): Promise<void> {
    this.window = window;
    window.setAlwaysOnTop(true, 'floating');
    await this.place(placement);
  }
  async place(placement: Placement): Promise<void> {
    this.placement = placement;
    if (this.window && !this.window.isDestroyed()) this.resize(this.window.getBounds());
  }
  resize(size: { width: number; height: number }): void {
    if (this.window && this.placement && !this.window.isDestroyed()) {
      this.window.setBounds(anchoredBounds(this.placement, size));
    }
  }
  async detach(): Promise<void> { this.window = undefined; }
}

export class FloatingDock implements Dock {
  readonly capabilities = { anchored: false, keepAbove: false, focusSafe: false };
  private window?: BrowserWindow;
  async attach(window: BrowserWindow, _placement: Placement): Promise<void> {
    this.window = window;
  }
  async place(_placement: Placement): Promise<void> {}
  resize(size: { width: number; height: number }): void {
    if (this.window && !this.window.isDestroyed()) this.window.setSize(size.width, size.height);
  }
  async detach(): Promise<void> { this.window = undefined; }
}
