import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@featherlog/contracts';
import { PlainFloat } from './dock';
import type { Dock } from './dock';

export function floatScript(title = 'featherlog-dock'): string {
  return `const title = ${JSON.stringify(title)};
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
  w.frameGeometryChanged.connect(() => {
    if (guard) return;
    const next = copy(w.frameGeometry);
    if (next.width !== previous.width || next.height !== previous.height) {
      const area = previousOutput.geometry;
      next.x = Math.max(area.x, Math.min(previous.x + previous.width - next.width,
        area.x + area.width - next.width));
      next.y = Math.max(area.y, Math.min(previous.y, area.y + area.height - next.height));
      guard = true;
      try { w.frameGeometry = next; }
      finally { guard = false; }
    }
    previous = copy(w.frameGeometry);
    previousOutput = w.output;
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
  run: Executor = execute): Promise<Dock> {
  let tool = '';
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
    const directory = join(userData, 'kwin');
    await mkdir(directory, { recursive: true });
    const file = join(directory, `${name}.js`);
    await writeFile(file, floatScript(), 'utf8');
    const response = await call('/Scripting', 'org.kde.kwin.Scripting.loadScript', file, name);
    const id = response.match(/^(?:\(\s*)?(?:int32\s+)?(\d+)(?:,?\s*\))?$/)?.[1];
    if (!id) throw new Error(`Invalid KWin script id: ${response}`);
    await call(`/Scripting/Script${id}`, 'org.kde.kwin.Script.run');
    log.info('KWin float script loaded', { tool, id });
    return new KWinFloat(unload);
  } catch (cause) {
    if (tool) await unload().catch(cleanup => log.warn('KWin cleanup failed', cleanup));
    log.warn('KWinFloat unavailable; using PlainFloat', cause);
    return new PlainFloat();
  }
}

export class KWinFloat extends PlainFloat {
  override readonly capabilities = { anchored: false, keepAbove: true, focusSafe: false };
  constructor(private unload: () => Promise<string>) { super(); }
  override async detach(): Promise<void> {
    await super.detach();
    await this.unload();
  }
}
