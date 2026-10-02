import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dispose, Logger, UnfoldSide } from '@featherlog/contracts';
import { PlainFloat, sideState } from './dock';
import type { Dock } from './dock';

export function floatScript(title = 'featherlog-dock', dynamicSide = true): string {
  return `const title = ${JSON.stringify(title)};
const dynamicSide = ${dynamicSide};
const managed = [];
function copy(g) {
  return { x: g.x, y: g.y, width: g.width, height: g.height };
}
function adopt(w) {
  if (w.caption !== title || managed.indexOf(w) >= 0) return;
  managed.push(w);
  w.keepAbove = true;
  w.onAllDesktops = true;
  w.skipTaskbar = true;
  w.skipPager = true;
  w.skipSwitcher = true;
  const output = workspace.screens.reduce((a, b) =>
    a.geometry.x + a.geometry.width > b.geometry.x + b.geometry.width ? a : b);
  const area = output.geometry;
  const g = w.frameGeometry;
  w.frameGeometry = { x: area.x + area.width - g.width,
    y: Math.round(area.y + (area.height - g.height) / 2), width: g.width, height: g.height };
  let previous = copy(w.frameGeometry);
  let previousOutput = w.output;
  let guard = false;
  let side = 'left';
  let revision = 0;
  function reportSide(initial) {
    if (!dynamicSide) return;
    if (initial) {
      callDBus('org.featherlog.Shell', '/Dock', 'org.featherlog.Dock', 'SetSide', side);
      return;
    }
    const version = revision;
    callDBus('org.featherlog.Shell', '/Dock', 'org.featherlog.Dock', 'GetExpanded', expanded => {
      if (expanded || version !== revision) return;
      const g = w.frameGeometry;
      const area = w.output.geometry;
      const candidate = g.x + g.width / 2 >= area.x + area.width / 2 ? 'left' : 'right';
      if (candidate === side) return;
      callDBus('org.featherlog.Shell', '/Dock', 'org.featherlog.Dock', 'SetSide', candidate,
        accepted => { if (accepted === 'left' || accepted === 'right') side = accepted; });
    });
  }
  reportSide(true);
  w.frameGeometryChanged.connect(() => {
    if (guard) return;
    const next = copy(w.frameGeometry);
    // QRectF edge arithmetic can change the last decimal bits during a pure move.
    const resized = Math.abs(next.width - previous.width) > 0.001 ||
      Math.abs(next.height - previous.height) > 0.001;
    const moved = next.x !== previous.x || next.y !== previous.y;
    if (!resized && !moved) return;
    revision++;
    if (resized) {
      const area = previousOutput.geometry;
      const x = side === 'left' ? previous.x + previous.width - next.width : previous.x;
      const y = previous.y + (previous.height - next.height) / 2;
      next.x = Math.max(area.x, Math.min(x,
        area.x + area.width - next.width));
      next.y = Math.max(area.y, Math.min(y, area.y + area.height - next.height));
      guard = true;
      try { w.frameGeometry = next; }
      finally { guard = false; }
    } else if (next.x !== previous.x || next.y !== previous.y) {
      reportSide(false);
    }
    previous = copy(w.frameGeometry);
    previousOutput = w.output;
  });
  // A dock must not inherit the compositor's edge-tiling geometry.
  w.tileChanged.connect(() => {
    if (guard || !w.tile) return;
    const restore = copy(previous);
    guard = true;
    try { w.tile = null; w.frameGeometry = restore; }
    finally { guard = false; }
    previous = copy(w.frameGeometry);
    previousOutput = w.output;
    revision++;
    reportSide(false);
  });
  // Continuous movement can invalidate every asynchronous direction query.
  w.interactiveMoveResizeFinished.connect(() => {
    const next = copy(w.frameGeometry);
    const area = w.output.geometry;
    next.x = Math.max(area.x, Math.min(next.x, area.x + area.width - next.width));
    next.y = Math.max(area.y, Math.min(next.y, area.y + area.height - next.height));
    if (next.x !== w.frameGeometry.x || next.y !== w.frameGeometry.y) {
      w.frameGeometry = next;
    }
    reportSide(false);
  });
}
function watch(w) {
  adopt(w);
  w.captionChanged.connect(() => adopt(w));
}
workspace.windowList().forEach(watch);
workspace.windowAdded.connect(watch);
`;
}

export type Executor = (file: string, args: string[]) => Promise<string>;
const execute: Executor = async (file, args) =>
  (await promisify(execFile)(file, args, { timeout: 5000 })).stdout.trim();
const name = 'featherlog-float';

export async function createKWinFloat(userData: string, log: Logger,
  run: Executor = execute,
  register = async (dock: KWinFloat) => {
    const { registerDockService } = await import('./dock-service');
    return registerDockService(side => dock.acceptSide(side), () => dock.expanded, log);
  },
): Promise<Dock> {
  let tool = '';
  let stopService: Dispose | undefined;
  const call = (path: string, method: string, ...args: string[]) => run(tool, tool === 'gdbus'
    ? ['call', '--session', '--dest', 'org.kde.KWin', '--object-path', path,
      '--method', method, ...args]
    : ['org.kde.KWin', path, method, ...args]);
  const unload = () => call('/Scripting', 'org.kde.kwin.Scripting.unloadScript', name);
  try {
    for (const candidate of ['qdbus6', 'qdbus', 'gdbus']) {
      tool = candidate;
      try {
        await unload();
        break;
      } catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause;
        tool = '';
      }
    }
    if (!tool) throw new Error('No DBus tool found');
    const dock = new KWinFloat(unload, () => stopService?.());
    stopService = await register(dock);
    const directory = join(userData, 'kwin');
    await mkdir(directory, { recursive: true });
    const file = join(directory, `${name}.js`);
    await writeFile(file, floatScript('featherlog-dock', !!stopService), 'utf8');
    const response = await call('/Scripting', 'org.kde.kwin.Scripting.loadScript', file, name);
    const id = response.match(/^(?:\(\s*)?(?:int32\s+)?(\d+)(?:,?\s*\))?$/)?.[1];
    if (!id) throw new Error(`Invalid KWin script id: ${response}`);
    // KWin uses the script count as its id; unloading another script can cause collisions.
    await call('/Scripting', 'org.kde.kwin.Scripting.start');
    log.info('KWin float script loaded', { tool, id });
    return dock;
  } catch (cause) {
    stopService?.();
    if (tool) await unload().catch(cleanup => log.warn('KWin cleanup failed', cleanup));
    log.warn('KWinFloat unavailable; using PlainFloat', cause);
    return new PlainFloat();
  }
}

export class KWinFloat extends PlainFloat {
  override readonly capabilities = { anchored: false, keepAbove: true, focusSafe: false };
  expanded = false;
  private readonly direction = sideState('left');
  override get side(): UnfoldSide { return this.direction.get(); }
  override onSide(listener: (side: UnfoldSide) => void): Dispose {
    return this.direction.onChange(listener);
  }
  acceptSide(side: UnfoldSide): UnfoldSide {
    if (!this.expanded) this.direction.set(side);
    return this.side;
  }
  constructor(private unload: () => Promise<string>, private stopService: Dispose = () => {}) {
    super();
  }
  override resize(size: { width: number; height: number; expanded?: boolean }): void {
    this.expanded = size.expanded ?? false;
    super.resize(size);
  }
  override async detach(): Promise<void> {
    await super.detach();
    try { await this.unload(); }
    finally { this.stopService(); }
  }
}
