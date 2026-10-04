import { EventEmitter } from 'node:events';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { isolatedEnv, smoke, startupReady } from './smoke.mjs';

const plugins = ['quest', 'notes', 'scribe'];
const loaded = plugins.map(id => `info [shell] kernel/plugin-loaded { pluginId: '${id}', version: '0.1.0' }`).join('\n');
const ready = `${loaded}\ninfo [shell] kernel/ready { pluginIds: [ 'quest', 'notes', 'scribe' ] }\ninfo [shell] Collapsed window ready { bounds: {} }\n`;
const unloaded = [...plugins].reverse().map(id => `info [shell] kernel/plugin-unloaded { pluginId: '${id}' }`).join('\n');

it('requires every loaded plugin, kernel readiness and a loaded window', () => {
  expect(startupReady(ready)).toBe(true);
  for (const line of ready.trim().split('\n')) expect(startupReady(ready.replace(line, ''))).toBe(false);
  expect(startupReady('')).toBe(false);
});

it.each(['kernel/plugin-failed', 'Startup failed', 'Shutdown failed', 'Page failed', 'Preload /app/index.cjs Error'])('fails even after readiness on %s', failure => {
  expect(() => startupReady(`${ready}\n${failure}`)).toThrow('failure');
});

it('isolates child HOME/XDG paths, disables injected renderer URLs and does not hand the app CI tokens', () => {
  const root = resolve('/isolated');
  const env = isolatedEnv(root, { HOME: '/real', XDG_CONFIG_HOME: '/real/config',
    GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', NODE_OPTIONS: '--require unsafe', ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_RENDERER_URL: 'http://localhost:5173', PATH: '/bin' });
  expect(env).toMatchObject({ HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), XDG_RUNTIME_DIR: join(root, 'runtime'),
    TMPDIR: join(root, 'tmp'), ELECTRON_RENDERER_URL: '', WAYLAND_DISPLAY: '', PATH: '/bin' });
  for (const secret of ['GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) expect(env).not.toHaveProperty(secret);
});

async function check(mode: string) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  let logFile = '';
  let startup = Promise.resolve();
  const launch = vi.fn((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    logFile = join(options.env.XDG_CONFIG_HOME!, 'Featherlog', 'logs', 'main.log');
    startup = mkdir(join(options.env.XDG_CONFIG_HOME!, 'Featherlog', 'logs'), { recursive: true })
      .then(() => writeFile(logFile, mode === 'missing' ? loaded : ready)).then(() => {
        if (mode === 'early') child.emit('exit', 0, null);
        if (mode === 'spawn') child.emit('error', new Error('xvfb missing'));
      });
    return child;
  });
  const quit = vi.fn(async () => {
    await startup;
    if (mode === 'quit') throw new Error('app.quit failed');
    await writeFile(logFile, ready + (mode === 'unclean' ? '' : unloaded));
    child.emit('exit', mode === 'exit' ? 1 : 0, null);
  });
  const result = smoke('/artifact.AppImage', { launch, quit, timeoutMs: mode === 'missing' ? 30 : 1000 });
  return { result, launch, quit };
}

it('starts xvfb with an actual AppImage path and quits only after logs confirm readiness', async () => {
  const f = await check('success'); await f.result;
  expect(f.launch).toHaveBeenCalledWith('xvfb-run', expect.arrayContaining([resolve('/artifact.AppImage'), '--appimage-extract-and-run']),
    expect.objectContaining({ detached: true }));
  expect(f.quit).toHaveBeenCalledOnce();
});

it.each([
  ['missing', 'timed out'], ['early', 'before readiness'], ['spawn', 'xvfb missing'],
  ['quit', 'app.quit failed'], ['exit', 'did not exit normally'], ['unclean', 'cleanly unload'],
])('rejects %s so release publication cannot proceed', async (mode, message) => {
  const f = await check(mode); await expect(f.result).rejects.toThrow(message);
  if (['missing', 'early', 'spawn'].includes(mode)) expect(f.quit).not.toHaveBeenCalled();
});
