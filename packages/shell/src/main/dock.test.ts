import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserWindow, Display, Rectangle } from 'electron';
import { defaultBounds, resizedBounds, ElectronFloat, PlainFloat, rightmostDisplay,
  selectDock, unfoldSide } from './dock';
import { JsonFiles } from './storage';

const display = (x: number, y = 0, width = 1920, height = 1080): Display => ({
  bounds: { x, y, width, height },
} as Display);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path =>
  rm(path, { recursive: true, force: true }))); });

it.each([
  ['win32', 'wayland-0', '', false, '', 'electron'],
  ['darwin', undefined, '', false, '', 'electron'],
  ['linux', undefined, 'KDE', false, '', 'electron'],
  ['linux', 'wayland-0', 'KDE', true, '', 'electron'],
  ['linux', 'wayland-0', 'KDE', false, 'x11', 'electron'],
  ['linux', 'wayland-0', 'KDE', false, '', 'kwin'],
  ['linux', 'wayland-0', 'ubuntu:KDE', false, '', 'kwin'],
  ['linux', 'wayland-0', 'GNOME', false, '', 'plain'],
] as const)('selects float on %s %s %s compat=%s ozone=%s', (os, wayland, desktop, compat, ozone, expected) => {
  expect(selectDock(os, wayland, desktop, compat, ozone)).toBe(expected);
});

it('starts at the rightmost display edge and vertical center in logical coordinates', () => {
  const left = display(-1920);
  const right = display(0, 100, 2560);
  expect(rightmostDisplay([right, left])).toBe(right);
  expect(defaultBounds(right.bounds, { width: 80, height: 320 }))
    .toEqual({ x: 2480, y: 480, width: 80, height: 320 });
});

it('preserves the right edge and top when expanding and collapsing a freely moved window', () => {
  const previous = { x: -500, y: 200, width: 80, height: 320 };
  const area = display(-1920).bounds;
  const expanded = resizedBounds(previous, { width: 400, height: 500 }, area);
  expect(expanded).toEqual({ x: -820, y: 200, width: 400, height: 500 });
  expect(resizedBounds(expanded, { width: 80, height: 320 }, area)).toEqual(previous);
});

it('clamps expanded content within both horizontal and vertical display boundaries', () => {
  expect(resizedBounds({ x: -1900, y: 950, width: 80, height: 80 },
    { width: 400, height: 500 }, display(-1920).bounds))
    .toEqual({ x: -1920, y: 580, width: 400, height: 500 });
  expect(resizedBounds({ x: 1900, y: -5, width: 80, height: 80 },
    { width: 400, height: 500 }, display(0).bounds))
    .toEqual({ x: 1520, y: 0, width: 400, height: 500 });
});

class Window extends EventEmitter {
  bounds = { x: 0, y: 0, width: 80, height: 320 };
  isDestroyed = () => false;
  getBounds = () => ({ ...this.bounds });
  setBounds = vi.fn((bounds: Rectangle) => { this.bounds = { ...bounds }; });
  setAlwaysOnTop = vi.fn();
  setSize = vi.fn();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'featherlog-float-'));
  directories.push(root);
  const file = join(root, 'float.json');
  const files = new JsonFiles();
  const timers = new Set<() => void>();
  const clock = { now: () => 1, setTimeout: (callback: () => void) => {
    timers.add(callback);
    return () => { timers.delete(callback); };
  } };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const screen = { getAllDisplays: () => [display(0), display(1920)],
    getDisplayMatching: () => display(1920) };
  const dock = new ElectronFloat(screen, files, file, clock, log);
  const window = new Window();
  return { dock, window, files, file, timers };
}

it('debounces moved positions, persists on detach and restores on attach', async () => {
  const { dock, window, files, file, timers } = await fixture();
  await dock.attach(window as unknown as BrowserWindow);
  expect(window.bounds).toEqual({ x: 3760, y: 380, width: 80, height: 320 });
  expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
  for (const x of [2000, 2200]) {
    window.bounds.x = x;
    window.emit('moved');
  }
  expect(timers.size).toBe(1);
  expect(await files.read(file)).toBeUndefined();
  for (const timer of timers) timer();
  await files.flush();
  expect(await files.read(file)).toEqual({ x: 2200, y: 380 });
  window.bounds.y = 400;
  window.emit('moved');
  await dock.detach();
  expect(window.listenerCount('moved')).toBe(0);
  expect(await files.read(file)).toEqual({ x: 2200, y: 400 });
  await dock.attach(window as unknown as BrowserWindow);
  expect(window.bounds).toEqual({ x: 2200, y: 400, width: 80, height: 320 });
  dock.resize({ width: 240, height: 500 });
  expect(window.bounds).toEqual({ x: 2200, y: 400, width: 240, height: 500 });
  await dock.detach();
});

it.each([{ x: 5000, y: 10 }, { x: 3840, y: 0 }, { x: 20, y: -1 }, { x: 'bad', y: 0 }])(
  'falls back to default for unavailable or invalid saved positions %j', async saved => {
    const { dock, window, files, file } = await fixture();
    await files.write(file, saved);
    await dock.attach(window as unknown as BrowserWindow);
    expect(window.bounds).toEqual({ x: 3760, y: 380, width: 80, height: 320 });
    await dock.detach();
  },
);

it('plain float resizes without positioning or unsupported capability promises', async () => {
  const window = new Window();
  const dock = new PlainFloat();
  expect(dock.side).toBe('right');
  await dock.attach(window as unknown as BrowserWindow);
  dock.resize({ width: 80, height: 320 });
  expect(window.setSize).toHaveBeenCalledWith(80, 320);
  expect(window.setBounds).not.toHaveBeenCalled();
  expect(dock.capabilities).toEqual({ anchored: false, keepAbove: false, focusSafe: false });
  await dock.detach();
  dock.resize({ width: 400, height: 500 });
  expect(window.setSize).toHaveBeenCalledOnce();
});

it.each([
  [-1920, -1800, 'right'], [-1920, -1000, 'left'],
  [0, 100, 'right'], [0, 920, 'left'], [2560, 2700, 'right'], [2560, 4200, 'left'],
] as const)('chooses a side on display x=%s for scroll x=%s', (x, scroll, side) => {
  expect(unfoldSide({ x: scroll, y: 0, width: 80, height: 248 }, display(x).bounds)).toBe(side);
});

it.each(['left', 'right'] as const)('keeps the %s unfold anchor and clamps both edges', side => {
  const previous = { x: -1000, y: 100, width: 80, height: 248 };
  const area = display(-1920).bounds;
  const expanded = resizedBounds(previous, { width: 434, height: 248 }, area, side);
  expect(expanded.x).toBe(side === 'left' ? -1354 : -1000);
  expect(resizedBounds(expanded, { width: 80, height: 248 }, area, side)).toEqual(previous);
  expect(resizedBounds({ ...previous, x: -1920 }, { width: 434, height: 248 }, area, side).x)
    .toBe(-1920);
  expect(resizedBounds({ ...previous, x: -80 }, { width: 434, height: 248 }, area, side).x)
    .toBe(-434);
});

it('notifies only collapsed user moves and freezes direction through expansion and collapse', async () => {
  const { dock, window } = await fixture();
  await dock.attach(window as unknown as BrowserWindow);
  expect(dock.side).toBe('left');
  const listener = vi.fn();
  const stop = dock.onSide(listener);
  window.bounds.x = 2200;
  window.emit('moved');
  expect(dock.side).toBe('right');
  dock.resize({ width: 720, height: 248, expanded: true });
  window.emit('moved');
  window.bounds.x = 3000;
  window.emit('moved');
  expect(dock.side).toBe('right');
  dock.resize({ width: 80, height: 248, expanded: false });
  window.emit('moved');
  expect(dock.side).toBe('right');
  window.bounds.x = 3001;
  window.emit('moved');
  expect(dock.side).toBe('left');
  expect(listener.mock.calls).toEqual([['right'], ['left']]);
  stop();
  window.bounds.x = 2200;
  window.emit('moved');
  expect(listener).toHaveBeenCalledTimes(2);
  await dock.detach();
});
