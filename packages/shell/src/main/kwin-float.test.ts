import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { createKWinFloat, floatScript, KWinFloat } from './kwin-float';
import { PlainFloat } from './dock';

const service = vi.hoisted(() => ({ loaded: false, stop: vi.fn(), register: vi.fn() }));
vi.mock('./dock-service', () => {
  service.loaded = true;
  return { registerDockService: service.register };
});
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path =>
  rm(path, { recursive: true, force: true }))); });
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
const missing = () => Object.assign(new Error('missing executable'), { code: 'ENOENT' });

it('leaves the DBus service unloaded when KWin support is imported', () => {
  expect(service.loaded).toBe(false);
});

it('loads the DBus service only after finding a KWin tool and cleans it up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'featherlog-kwin-'));
  directories.push(root);
  service.register.mockResolvedValue(service.stop);
  const run = vi.fn(async (_file: string, args: string[]) =>
    args.includes('org.kde.kwin.Scripting.loadScript') ? '3' : '');
  const dock = await createKWinFloat(root, log(), run);
  expect(service.loaded).toBe(true);
  expect(service.register).toHaveBeenCalledOnce();
  const [acceptSide, expanded] = service.register.mock.calls[0]! as [
    (side: 'left' | 'right') => 'left' | 'right', () => boolean,
  ];
  expect(acceptSide('right')).toBe('right');
  dock.resize({ width: 80, height: 320, expanded: true });
  expect(expanded()).toBe(true);
  await dock.detach();
  expect(service.stop).toHaveBeenCalledOnce();
});

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
  const dock = await createKWinFloat(root, log(), run, async () => () => {});
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
  const dock = await createKWinFloat(root, log(), run, async () => () => {});
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
  let expanded = false;
  let defer = false;
  let pending: ((expanded: boolean) => void) | undefined;
  const callDBus = vi.fn((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback !== 'function') return;
    if (args[3] === 'GetExpanded' && defer) {
      pending = callback as (expanded: boolean) => void;
    } else callback(args[3] === 'GetExpanded' ? expanded : args[4]);
  });
  runInNewContext(floatScript(), { callDBus, workspace: {
    screens: [{ geometry: area }, { geometry: { x: 0, y: 0, width: 1920, height: 1080 } }],
    windowList: () => [window], windowAdded: { connect: (callback: typeof added) => { added = callback; } },
  } });
  expect(assignments).toBe(0);
  window.caption = 'featherlog-dock';
  captionChanged();
  expect(geometry).toEqual({ x: 3760, y: 480, width: 80, height: 320 });
  expect(callDBus).toHaveBeenCalledWith('org.featherlog.Shell', '/Dock',
    'org.featherlog.Dock', 'SetSide', 'left');
  expect(window).toMatchObject({ keepAbove: true, onAllDesktops: true,
    skipTaskbar: true, skipPager: true, skipSwitcher: true });
  window.frameGeometry = { ...geometry, x: 2500, y: 300 };
  expect(geometry.x).toBe(2500);
  expect(callDBus).toHaveBeenCalledWith('org.featherlog.Shell', '/Dock',
    'org.featherlog.Dock', 'SetSide', 'right', expect.any(Function));
  window.frameGeometry = { ...geometry, width: 400, height: 500 };
  expect(geometry).toEqual({ x: 2500, y: 210, width: 400, height: 500 });
  for (const height of [321, 334.4, 287.2, 320]) {
    window.frameGeometry = { ...geometry, height };
    expect(geometry.y + geometry.height / 2).toBeCloseTo(460);
  }
  window.frameGeometry = { ...geometry, width: 80, height: 320 };
  expect(geometry.x).toBe(2500);
  window.frameGeometry = { ...geometry, x: 3700 };
  window.frameGeometry = { ...geometry, width: 400 };
  expect(geometry.x).toBe(3380);
  window.frameGeometry = { ...geometry, width: 80 };
  window.frameGeometry = { ...geometry, x: 1920 };
  window.frameGeometry = { ...geometry, width: 400 };
  expect(geometry.x).toBe(1920);
  expanded = true;
  const reports = callDBus.mock.calls.filter(args => args[3] === 'SetSide').length;
  window.frameGeometry = { ...geometry, x: 3000 };
  expect(callDBus.mock.calls.filter(args => args[3] === 'SetSide')).toHaveLength(reports);
  window.frameGeometry = { ...geometry, width: 80 };
  expect(geometry.x).toBe(3000);
  expanded = false;
  defer = true;
  window.frameGeometry = { ...geometry, x: 3100 };
  window.frameGeometry = { ...geometry, width: 81 };
  pending!(false);
  expect(callDBus.mock.calls.filter(args => args[3] === 'SetSide')).toHaveLength(reports);
  const before = assignments;
  added(window);
  captionChanged();
  expect(assignments).toBe(before);
});

it('keeps KWin positioning but fixes its side left if the DBus service cannot register', async () => {
  const root = await mkdtemp(join(tmpdir(), 'featherlog-kwin-'));
  directories.push(root);
  const run = vi.fn(async (_file: string, args: string[]) =>
    args.includes('org.kde.kwin.Scripting.loadScript') ? '3' : '');
  const dock = await createKWinFloat(root, log(), run, async () => undefined);
  expect(dock).toBeInstanceOf(KWinFloat);
  expect(dock.side).toBe('left');
  expect(await readFile(join(root, 'kwin/featherlog-float.js'), 'utf8'))
    .toBe(floatScript('featherlog-dock', false));
  await dock.detach();
});

it('rejects a late direction report while expanded and cleans up the service', async () => {
  const stop = vi.fn();
  const dock = new KWinFloat(async () => '', stop);
  const listener = vi.fn();
  dock.onSide(listener);
  dock.resize({ width: 434, height: 248, expanded: true });
  expect(dock.acceptSide('right')).toBe('left');
  expect(listener).not.toHaveBeenCalled();
  dock.resize({ width: 84, height: 248, expanded: false });
  expect(dock.acceptSide('right')).toBe('right');
  expect(listener).toHaveBeenCalledWith('right');
  await dock.detach();
  expect(stop).toHaveBeenCalledOnce();
});
