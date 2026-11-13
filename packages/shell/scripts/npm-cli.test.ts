import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
const installShortcut = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('./npm-shortcut.mjs', () => ({ installShortcut }));
let child: EventEmitter & { kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.resetModules();
  child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  spawn.mockReset().mockReturnValue(child);
  installShortcut.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('process', { ...process, argv: ['node', 'featherlog'], exitCode: 0,
    on: vi.fn(), removeListener: vi.fn(), env: { ...process.env,
      ELECTRON_RUN_AS_NODE: '1', ELECTRON_RENDERER_URL: 'https://unexpected.example' } });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['--help', '--version'])('handles %s without starting or downloading Electron', async flag => {
  process.argv.push(flag);
  await import('./npm-cli.mjs');
  expect(spawn).not.toHaveBeenCalled();
  expect(installShortcut).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledOnce();
});

it('launches the bundled app independently of cwd, passes arguments, and strips dev overrides', async () => {
  process.argv.push('--ozone-platform=wayland');
  await import('./npm-cli.mjs');
  const [command, args, options] = spawn.mock.calls[0]!;
  expect(command).toBe(process.execPath);
  expect(args[0]).toMatch(/electron[/\\]cli\.js$/);
  expect(args[1]).toMatch(/packages[/\\]shell[/\\]$/);
  expect(installShortcut).toHaveBeenCalledWith(args[1]);
  expect(args[2]).toBe('--ozone-platform=wayland');
  expect(options.stdio).toBe('inherit');
  expect(options.env.FEATHERLOG_NPM).toBe('1');
  expect(options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  expect(options.env).not.toHaveProperty('ELECTRON_RENDERER_URL');
  const handlers = vi.mocked(process.on).mock.calls;
  for (const [signal, handler] of handlers) {
    handler();
    expect(child.kill).toHaveBeenCalledWith(signal);
  }
  child.emit('close', 7, null);
  expect(process.exitCode).toBe(7);
  expect(process.removeListener).toHaveBeenCalledTimes(2);
});

it('still launches if the application menu cannot be written', async () => {
  installShortcut.mockRejectedValue(new Error('EACCES'));
  await import('./npm-cli.mjs');
  expect(console.warn).toHaveBeenCalledWith('featherlog/shortcut-failed: EACCES');
  expect(spawn).toHaveBeenCalledOnce();
  child.emit('close', 0, null);
});

it.each(['SIGINT', 'SIGTERM', 'SIGKILL'])('reports abnormal exit from %s', async signal => {
  await import('./npm-cli.mjs');
  child.emit('close', null, signal);
  expect(process.exitCode).toBe(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
});

it('reports a spawn failure and removes signal handlers when the child closes', async () => {
  await import('./npm-cli.mjs');
  child.emit('error', new Error('ENOENT'));
  child.emit('close', -2, null);
  expect(console.error).toHaveBeenCalledWith('featherlog/launch-failed: ENOENT');
  expect(process.exitCode).not.toBe(0);
  expect(process.removeListener).toHaveBeenCalledTimes(2);
});
