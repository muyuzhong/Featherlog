import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Json, PluginManifest } from '@featherlog/contracts';
import { Settings } from './settings';
import { JsonFiles } from './storage';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, {
  recursive: true, force: true,
}))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'featherlog-settings-'));
  directories.push(root);
  const manifests: PluginManifest[] = [{ id: 'example', name: 'Example', version: '1', contributes: {
    settings: { schema: { type: 'object', properties: {
      hour: { type: 'integer', minimum: 0, maximum: 23, default: 4 },
      scale: { type: 'number', minimum: 0, maximum: 1, default: .5 },
      label: { type: 'string', default: 'label' },
      enabled: { type: 'boolean', default: true },
    } } },
  } }];
  const files = new JsonFiles();
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { root, files, log, manifests, settings: new Settings(root, manifests, undefined, files, log) };
}

it('applies shell and plugin defaults without sharing mutable snapshots', async () => {
  const { settings } = await fixture();
  expect(settings.all()).toEqual({
    shell: { paper: 'vellum', compatMode: false, autoUpdate: true },
    example: { hour: 4, scale: .5, label: 'label', enabled: true },
  });
  const snapshot = settings.all();
  snapshot.example!.hour = 12;
  expect(settings.forPlugin('example').get('hour')).toBe(4);
});

it.each([
  ['shell', 'edge', 'bottom'], ['shell', 'display', 'not-a-display'],
  ['shell', 'verticalPosition', -1], ['shell', 'verticalPosition', 1.1],
  ['shell', 'autoUpdate', 'true'], ['shell', 'autoUpdate', 1],
  ['shell', 'paper', 'white'], ['shell', 'compatMode', 1],
  ['example', 'hour', 3.5], ['example', 'hour', 24], ['example', 'scale', null],
  ['example', 'label', 1], ['example', 'enabled', 'yes'], ['unknown', 'key', true],
  ['shell', '__proto__', 'x'], ['example', 'unknown', 1],
] as const)('rejects %s/%s = %s with its contract error code', async (scope, key, value) => {
  const { settings } = await fixture();
  await expect(settings.set(scope, key, value)).rejects.toMatchObject({ code: 'shell/invalid-setting' });
});

it('serializes writes, persists the required shape and notifies plugins and windows once', async () => {
  const { root, settings, files, log, manifests } = await fixture();
  const plugin = vi.fn();
  const window = vi.fn();
  const offPlugin = settings.forPlugin('example').onChange(plugin);
  const offWindow = settings.onChange(window);
  await Promise.all([
    settings.set('example', 'hour', 0), settings.set('shell', 'paper', 'aged'),
    settings.set('shell', 'compatMode', true), settings.set('example', 'scale', .25),
  ]);
  expect(plugin).toHaveBeenCalledTimes(2);
  expect(window).toHaveBeenCalledTimes(4);
  await settings.set('example', 'hour', 0);
  expect(plugin).toHaveBeenCalledTimes(2);
  await settings.flush();
  const saved = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')) as Json;
  expect(saved).toMatchObject({ shell: { paper: 'aged', compatMode: true },
    plugins: { example: { hour: 0, scale: .25 } } });
  expect(new Settings(root, manifests, saved, files, log).all()).toEqual(settings.all());
  offPlugin();
  offWindow();
  await settings.set('example', 'hour', 1);
  expect(plugin).toHaveBeenCalledTimes(2);
  expect(window).toHaveBeenCalledTimes(4);
});

it('does not commit or notify on disk failure and isolates failing listeners', async () => {
  const { settings, files, log } = await fixture();
  const listener = vi.fn();
  settings.onChange(() => { throw new Error('listener'); });
  settings.onChange(listener);
  vi.spyOn(files, 'write').mockRejectedValueOnce(new Error('disk full'));
  await expect(settings.set('example', 'hour', 5)).rejects.toThrow('disk full');
  expect(settings.forPlugin('example').get('hour')).toBe(4);
  expect(listener).not.toHaveBeenCalled();
  await settings.set('example', 'hour', 5);
  expect(listener).toHaveBeenCalledOnce();
  expect(log.error).toHaveBeenCalledOnce();
});

it('ignores removed placement settings from existing files', async () => {
  const { root, manifests, files, log } = await fixture();
  const settings = new Settings(root, manifests, { shell: { edge: 'left', display: '42',
    verticalPosition: .2 }, plugins: {} }, files, log);
  expect(settings.all().shell).toEqual({ paper: 'vellum', compatMode: false, autoUpdate: true });
});
