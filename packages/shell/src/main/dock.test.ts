import { expect, it, vi } from 'vitest';
import type { BrowserWindow, Display } from 'electron';
import { anchoredBounds, ElectronDock, FloatingDock, selectDisplay, selectDock } from './dock';

const display = (id: number, x: number, y = 0, width = 1920, height = 1080): Display => ({
  id, workArea: { x, y, width, height },
} as Display);

it.each([
  ['win32', 'wayland-0', '', false, '', 'electron'],
  ['darwin', undefined, '', false, '', 'electron'],
  ['linux', undefined, 'KDE', false, '', 'electron'],
  ['linux', 'wayland-0', 'KDE', true, '', 'electron'],
  ['linux', 'wayland-0', 'KDE', false, 'x11', 'electron'],
  ['linux', 'wayland-0', 'KDE', false, '', 'kwin'],
  ['linux', 'wayland-0', 'ubuntu:KDE', false, '', 'kwin'],
  ['linux', 'wayland-0', 'GNOME', false, '', 'floating'],
] as const)('selects dock on %s %s %s compat=%s ozone=%s', (os, wayland, desktop, compat, ozone, expected) => {
  expect(selectDock(os, wayland, desktop, compat, ozone)).toBe(expected);
});

it('selects extreme displays by geometry, independent of ids, order and scale', () => {
  const left = display(90, -1920);
  const right = display(1, 0, 100, 2560);
  expect(selectDisplay([right, left], 'left', 'auto')).toBe(left);
  expect(selectDisplay([left, right], 'right', 'auto')).toBe(right);
  expect(selectDisplay([left, right], 'right', '90')).toBe(left);
  expect(selectDisplay([left, right], 'right', 'disconnected')).toBe(right);
});

it.each([0, .5, 1])('anchors and resizes at verticalPosition=%s using logical work area', async verticalPosition => {
  const placement = { edge: 'right' as const, display: display(1, -1600, 40, 1600, 960),
    verticalPosition };
  const size = { width: 80, height: 320 };
  expect(anchoredBounds(placement, size)).toEqual({ x: -80,
    y: 40 + 640 * verticalPosition, ...size });
  expect(anchoredBounds({ ...placement, edge: 'left' }, size).x).toBe(-1600);
  const window = { isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, ...size }),
    setAlwaysOnTop: vi.fn(), setBounds: vi.fn(), setSize: vi.fn() };
  const dock = new ElectronDock();
  await dock.attach(window as unknown as BrowserWindow, placement);
  expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
  dock.resize({ width: 240, height: 500 });
  expect(window.setBounds).toHaveBeenLastCalledWith({ x: -240,
    y: Math.round(40 + 460 * verticalPosition), width: 240, height: 500 });
  await dock.place({ ...placement, edge: 'left' });
  expect(window.setBounds.mock.calls.at(-1)![0].x).toBe(-1600);
  await dock.detach();
  const calls = window.setBounds.mock.calls.length;
  dock.resize(size);
  expect(window.setBounds).toHaveBeenCalledTimes(calls);
});

it('floating dock resizes without attempting positioning or promising unsupported capabilities', async () => {
  const window = { isDestroyed: () => false, setSize: vi.fn(), setBounds: vi.fn() };
  const dock = new FloatingDock();
  const placement = { edge: 'right' as const, display: display(1, 0), verticalPosition: .5 };
  await dock.attach(window as unknown as BrowserWindow, placement);
  await dock.place(placement);
  dock.resize({ width: 80, height: 320 });
  expect(window.setSize).toHaveBeenCalledWith(80, 320);
  expect(window.setBounds).not.toHaveBeenCalled();
  expect(dock.capabilities).toEqual({ anchored: false, keepAbove: false, focusSafe: false });
  await dock.detach();
});
