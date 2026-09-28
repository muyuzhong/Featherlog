import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { createKWinFloat, floatScript } from './kwin-float';
import { PlainFloat } from './dock';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path =>
  rm(path, { recursive: true, force: true }))); });
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
const missing = () => Object.assign(new Error('missing executable'), { code: 'ENOENT' });

it('generates the small float script with a safely encoded title', () => {
  expect(floatScript()).toMatchSnapshot();
  expect(floatScript('a"b')).toContain('const title = "a\\"b";');
});

it.each(['qdbus6', 'qdbus', 'gdbus'])('loads and unloads with %s in fallback order', async tool => {
  const root = await mkdtemp(join(tmpdir(), 'featherlog-kwin-'));
  directories.push(root);
  const run = vi.fn(async (file: string, args: string[]) => {
    if (file !== tool) throw missing();
    if (args.includes('org.kde.kwin.Scripting.loadScript')) return tool === 'gdbus' ? '(7,)' : '7';
    return '';
  });
  const dock = await createKWinFloat(root, log(), run);
  expect(dock.capabilities).toEqual({ anchored: false, keepAbove: true, focusSafe: false });
  expect(await readFile(join(root, 'kwin/featherlog-float.js'), 'utf8')).toBe(floatScript());
  await dock.detach();
  const attempts = ['qdbus6', 'qdbus', 'gdbus'];
  expect(run.mock.calls.slice(0, attempts.indexOf(tool) + 1).map(call => call[0]))
    .toEqual(attempts.slice(0, attempts.indexOf(tool) + 1));
  const prefix = (path: string, method: string, ...args: string[]) => tool === 'gdbus'
    ? ['call', '--session', '--dest', 'org.kde.KWin', '--object-path', path, '--method', method, ...args]
    : ['org.kde.KWin', path, method, ...args];
  expect(run.mock.calls.filter(call => call[0] === tool).map(call => call[1])).toEqual([
    prefix('/Scripting', 'org.kde.kwin.Scripting.unloadScript', 'featherlog-float'),
    prefix('/Scripting', 'org.kde.kwin.Scripting.loadScript',
      join(root, 'kwin/featherlog-float.js'), 'featherlog-float'),
    prefix('/Scripting/Script7', 'org.kde.kwin.Script.run'),
    prefix('/Scripting', 'org.kde.kwin.Scripting.unloadScript', 'featherlog-float'),
  ]);
});

it('falls back to PlainFloat and logs when all DBus tools are absent', async () => {
  const logger = log();
  const run = vi.fn(async () => { throw missing(); });
  const dock = await createKWinFloat('/unused', logger, run);
  expect(dock).toBeInstanceOf(PlainFloat);
  expect(dock.capabilities.keepAbove).toBe(false);
  expect(run).toHaveBeenCalledTimes(3);
  expect(logger.warn).toHaveBeenCalled();
  await dock.detach();
  expect(run).toHaveBeenCalledTimes(3);
});

it('cleans up a loaded script if run fails instead of promising keepAbove', async () => {
  const root = await mkdtemp(join(tmpdir(), 'featherlog-kwin-'));
  directories.push(root);
  const run = vi.fn(async (_file: string, args: string[]) => {
    if (args.includes('org.kde.kwin.Script.run')) throw new Error('DBus failed');
    return args.includes('org.kde.kwin.Scripting.loadScript') ? '2' : '';
  });
  const dock = await createKWinFloat(root, log(), run);
  expect(dock.capabilities.keepAbove).toBe(false);
  expect(run.mock.calls.at(-1)![1]).toContain('org.kde.kwin.Scripting.unloadScript');
});

it('adopts late titles, preserves user movement, compensates only resize and guards recursion', () => {
  let changed = () => {};
  let captionChanged = () => {};
  let added = (_window: unknown) => {};
  const area = { x: 1920, y: 100, width: 1920, height: 1080 };
  let geometry = { x: 0, y: 0, width: 80, height: 320 };
  let assignments = 0;
  const window = { caption: 'loading', keepAbove: false, onAllDesktops: false,
    skipTaskbar: false, skipPager: false, skipSwitcher: false, output: { geometry: area },
    frameGeometryChanged: { connect: (callback: () => void) => { changed = callback; } },
    captionChanged: { connect: (callback: () => void) => { captionChanged = callback; } },
    get frameGeometry() { return geometry; },
    set frameGeometry(value) {
      geometry = value;
      this.output = { geometry: value.x + value.width / 2 >= 3840
        ? { ...area, x: 3840 } : area };
      assignments++;
      changed();
    },
  };
  runInNewContext(floatScript(), { workspace: {
    screens: [{ geometry: area }, { geometry: { x: 0, y: 0, width: 1920, height: 1080 } }],
    windowList: () => [window], windowAdded: { connect: (callback: typeof added) => { added = callback; } },
  } });
  expect(assignments).toBe(0);
  window.caption = 'featherlog-dock';
  captionChanged();
  expect(geometry).toEqual({ x: 3760, y: 480, width: 80, height: 320 });
  expect(window).toMatchObject({ keepAbove: true, onAllDesktops: true,
    skipTaskbar: true, skipPager: true, skipSwitcher: true });
  window.frameGeometry = { ...geometry, x: 2500, y: 300 };
  expect(geometry.x).toBe(2500);
  window.frameGeometry = { ...geometry, width: 400, height: 500 };
  expect(geometry).toEqual({ x: 2180, y: 300, width: 400, height: 500 });
  window.frameGeometry = { ...geometry, width: 80, height: 320 };
  expect(geometry.x).toBe(2500);
  window.frameGeometry = { ...geometry, x: 3700 };
  window.frameGeometry = { ...geometry, width: 400 };
  expect(geometry.x).toBe(3380);
  window.frameGeometry = { ...geometry, width: 80 };
  window.frameGeometry = { ...geometry, x: 1920 };
  window.frameGeometry = { ...geometry, width: 400 };
  expect(geometry.x).toBe(1920);
  const before = assignments;
  added(window);
  captionChanged();
  expect(assignments).toBe(before);
});
