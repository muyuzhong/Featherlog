import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';
import type { Clock, Json, UnfoldSide } from '@featherlog/contracts';
import { Windows } from './windows';
import { JsonFiles } from './storage';

const electron = vi.hoisted(() => ({
  app: { quit: vi.fn() }, BrowserWindow: vi.fn(),
  Menu: { buildFromTemplate: vi.fn((_items: Electron.MenuItemConstructorOptions[]) => ({ popup: vi.fn() })) },
  screen: { getDisplayMatching: vi.fn(), getAllDisplays: vi.fn() },
}));
vi.mock('electron', () => electron);
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

class FakeWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn(), send: vi.fn() });
  bounds: Rectangle;
  destroyed = false;
  focused = false;
  show = vi.fn();
  showInactive = vi.fn();
  focus = vi.fn(() => { this.focused = true; });
  setFocusable = vi.fn();
  isFocused = () => this.focused;
  hide = vi.fn();
  destroy = vi.fn(() => { this.destroyed = true; });
  isDestroyed = () => this.destroyed;
  getBounds = () => ({ ...this.bounds });
  loadURL = vi.fn(async () => {});
  loadFile = vi.fn(async () => {});
  setVisibleOnAllWorkspaces = vi.fn();
  constructor(readonly options: BrowserWindowConstructorOptions) {
    super();
    this.bounds = { x: options.x ?? 0, y: options.y ?? 0,
      width: options.width!, height: options.height! };
  }
}

function fixture(focusSafe = true, saved?: Json) {
  vi.stubEnv('ELECTRON_RENDERER_URL', '');
  const created: FakeWindow[] = [];
  electron.BrowserWindow.mockImplementation(function (options: BrowserWindowConstructorOptions) {
    const window = new FakeWindow(options);
    created.push(window);
    return window;
  });
  const display = (x: number) => ({ bounds: { x, y: 0, width: 1920, height: 1080 },
    workArea: { x, y: 40, width: 1920, height: 1040 } });
  electron.screen.getDisplayMatching.mockReturnValue(display(-1920));
  electron.screen.getAllDisplays.mockReturnValue([display(1920), display(-1920), display(0)]);
  let time = 0;
  const timers = new Map<() => void, number>();
  const clock: Clock = { now: () => time, setTimeout(callback, ms) {
    timers.set(callback, time + ms);
    return () => { timers.delete(callback); };
  } };
  const files = new JsonFiles(clock);
  vi.spyOn(files, 'read').mockResolvedValue(saved);
  vi.spyOn(files, 'write').mockResolvedValue();
  const offSide = vi.fn();
  const dock = { capabilities: { anchored: false, keepAbove: true, focusSafe }, side: 'left' as const,
    attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), resize: vi.fn(),
    onSide: vi.fn((_listener: (side: UnfoldSide) => void) => offSide) };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const register = vi.fn();
  const view = vi.fn();
  const open = vi.fn();
  const windows = new Windows(dock, files, '/data', clock, log, register, view, open);
  return { windows, created, dock, files, log, register, view, open, offSide, timers,
    async advance(ms: number) {
      time += ms;
      for (const [callback, at] of timers) {
        if (at <= time) { timers.delete(callback); callback(); }
      }
      await Promise.resolve();
    },
  };
}

it('creates secure windows, attaches before showing inactive and preserves the dock title', async () => {
  const f = fixture();
  vi.stubGlobal('process', { ...process, platform: 'darwin' });
  await f.windows.start();
  const collapsed = f.created[0]!;
  expect(collapsed.options).toMatchObject({ show: false, frame: false, transparent: true,
    resizable: true, skipTaskbar: true, hasShadow: false, focusable: false,
    title: 'featherlog-dock', width: 80, height: 320 });
  expect(f.dock.attach).toHaveBeenCalledWith(collapsed);
  expect(f.dock.attach.mock.invocationCallOrder[0]).toBeLessThan(collapsed.showInactive.mock.invocationCallOrder[0]!);
  expect(collapsed.show).not.toHaveBeenCalled();
  expect(collapsed.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true });
  const titleEvent = { preventDefault: vi.fn() };
  collapsed.emit('page-title-updated', titleEvent);
  expect(titleEvent.preventDefault).toHaveBeenCalledOnce();
  collapsed.webContents.emit('context-menu', {});
  expect(electron.Menu.buildFromTemplate).not.toHaveBeenCalled();
  await f.windows.openPanel();
  for (const window of f.created) {
    expect(window.options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
    expect(window.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' });
    for (const event of ['will-navigate', 'will-attach-webview']) {
      const preventDefault = vi.fn();
      window.webContents.emit(event, { preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
  }
  f.dock.onSide.mock.calls[0]![0]('right');
  expect(collapsed.webContents.send).toHaveBeenCalledWith('dock:side-changed', 'right');
});

it('requires a click for dock keyboard focus and revokes it on blur or a rejected activation', async () => {
  const f = fixture(false);
  await f.windows.start();
  const collapsed = f.created[0]!;
  const event = { preventDefault: vi.fn() };
  const mouse = (type: string) => collapsed.webContents.emit('before-mouse-event', event, { type });
  collapsed.emit('focus');
  mouse('mouseMove');
  expect(collapsed.focus).not.toHaveBeenCalled();
  expect(collapsed.setFocusable).not.toHaveBeenCalled();
  expect(f.view).not.toHaveBeenCalled();
  mouse('mouseDown');
  expect(collapsed.setFocusable).toHaveBeenLastCalledWith(true);
  expect(collapsed.focus).toHaveBeenCalledOnce();
  mouse('mouseUp');
  expect(collapsed.setFocusable).toHaveBeenCalledOnce();
  collapsed.focused = false;
  collapsed.emit('blur');
  expect(collapsed.setFocusable).toHaveBeenLastCalledWith(false);
  collapsed.emit('focus');
  expect(collapsed.setFocusable).toHaveBeenLastCalledWith(false);
  collapsed.focus.mockImplementationOnce(() => {});
  mouse('mouseDown');
  mouse('mouseUp');
  expect(collapsed.setFocusable.mock.calls.map(([value]) => value)).toEqual([true, false, true, false]);
  expect(event.preventDefault).not.toHaveBeenCalled();
  await f.windows.openPanel();
  const panel = f.created[1]!;
  expect(panel.options.focusable).toBe(true);
  expect(panel.focus).toHaveBeenCalledOnce();
  panel.emit('blur');
  mouse('mouseMove');
  expect(panel.setFocusable).not.toHaveBeenCalled();
});

it('clamps and rounds dock dimensions, rejects malformed sizes, and emits only view transitions', () => {
  const f = fixture();
  for (const invalid of [null, {}, { width: NaN, height: 80, expanded: false },
    { width: 80, height: Infinity, expanded: false }, { width: 80, height: 80, expanded: 1 }]) {
    f.windows.resize(invalid);
  }
  expect(f.dock.resize).not.toHaveBeenCalled();
  f.windows.resize({ width: 0, height: 2000, expanded: true });
  expect(f.dock.resize).toHaveBeenLastCalledWith({ width: 40, height: 900, expanded: true });
  f.windows.resize({ width: 800, height: 0, expanded: true });
  expect(f.dock.resize).toHaveBeenLastCalledWith({ width: 720, height: 80, expanded: true });
  f.windows.resize({ width: 80.6, height: 320.2, expanded: false });
  expect(f.dock.resize).toHaveBeenLastCalledWith({ width: 81, height: 320, expanded: false });
  expect(f.view.mock.calls).toEqual([['preview'], ['collapsed']]);
});

it.each([true, false])('centers a new panel on the supported display, focusSafe=%s', async focusSafe => {
  const f = fixture(focusSafe);
  await f.windows.start();
  await Promise.all([f.windows.openPanel(), f.windows.openPanel()]);
  expect(f.created).toHaveLength(2);
  const panel = f.created[1]!;
  expect(panel.options).toMatchObject({ x: (focusSafe ? -1920 : 1920) + 340, y: 160,
    width: 1240, height: 800, minWidth: 960, minHeight: 640, backgroundColor: '#1f150d' });
  expect(panel.show).toHaveBeenCalled();
  expect(panel.focus).toHaveBeenCalled();
  expect(f.register.mock.calls.map(call => call[1])).toEqual(['collapsed', 'panel']);
});

it('restores saved bounds, hides on close or Escape, and reuses the loaded panel', async () => {
  const bounds = { x: 10, y: 20, width: 1000, height: 700 };
  const f = fixture(true, bounds);
  await f.windows.openPanel();
  const panel = f.created[0]!;
  expect(panel.bounds).toEqual(bounds);
  const event = { preventDefault: vi.fn() };
  panel.emit('close', event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(panel.hide).toHaveBeenCalledOnce();
  expect(panel.destroy).not.toHaveBeenCalled();
  expect(f.view).toHaveBeenLastCalledWith('collapsed');
  f.windows.resize({ width: 400, height: 320, expanded: true });
  await f.windows.openPanel();
  panel.webContents.emit('before-input-event', event, { key: 'Escape', type: 'keyUp' });
  expect(panel.hide).toHaveBeenCalledOnce();
  panel.webContents.emit('before-input-event', event, { key: 'Escape', type: 'keyDown' });
  expect(panel.hide).toHaveBeenCalledTimes(2);
  expect(f.view).toHaveBeenLastCalledWith('preview');
  expect(panel.loadFile).toHaveBeenCalledOnce();
  expect(f.created).toHaveLength(1);
});

it.each([{ x: 0, y: 0, width: 959, height: 640 }, { x: 0, y: 'bad', width: 960, height: 640 }])(
  'ignores invalid saved bounds: %j', async saved => {
    const f = fixture(true, saved);
    await f.windows.openPanel();
    expect(f.created[0]!.bounds).toEqual({ x: 2260, y: 160, width: 1240, height: 800 });
  },
);

it('debounces bounds writes and flushes the latest bounds and detaches on shutdown', async () => {
  const f = fixture();
  await f.windows.start();
  await f.windows.openPanel();
  const panel = f.created[1]!;
  panel.emit('move');
  await f.advance(100);
  panel.bounds.width = 1300;
  panel.emit('resize');
  await f.advance(149);
  expect(f.files.write).not.toHaveBeenCalled();
  await f.advance(1);
  expect(f.files.write).toHaveBeenCalledExactlyOnceWith(join('/data', 'panel.json'), panel.bounds);
  panel.bounds.x = 500;
  panel.emit('move');
  await f.windows.stop();
  expect(f.files.write).toHaveBeenLastCalledWith(join('/data', 'panel.json'), panel.bounds);
  expect(f.dock.detach).toHaveBeenCalledOnce();
  expect(f.offSide).toHaveBeenCalledOnce();
  expect(f.timers.size).toBe(0);
  const event = { preventDefault: vi.fn() };
  panel.emit('close', event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  await f.windows.openPanel();
  expect(panel.show).toHaveBeenCalledOnce();
});

it('destroys failed panel loads and allows another open attempt', async () => {
  const f = fixture();
  electron.BrowserWindow.mockImplementationOnce(function (options: BrowserWindowConstructorOptions) {
    const window = new FakeWindow(options);
    window.loadFile.mockRejectedValueOnce(new Error('load failed'));
    f.created.push(window);
    return window;
  });
  await expect(f.windows.openPanel()).rejects.toThrow('load failed');
  expect(f.created[0]!.destroy).toHaveBeenCalledOnce();
  await f.windows.openPanel();
  expect(f.created[1]!.show).toHaveBeenCalledOnce();
});

it('does not show an in-flight startup after shutdown and routes menu actions', async () => {
  const f = fixture();
  let attached!: () => void;
  f.dock.attach.mockReturnValueOnce(new Promise<void>(resolve => { attached = resolve; }));
  const starting = f.windows.start();
  await f.windows.stop();
  attached();
  await starting;
  expect(f.created[0]!.showInactive).not.toHaveBeenCalled();
  f.windows.menu();
  const items = electron.Menu.buildFromTemplate.mock.calls[0]![0];
  for (const item of items) item.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
  expect(f.open.mock.calls).toEqual([[false], [true]]);
  expect(electron.app.quit).toHaveBeenCalledOnce();
});
