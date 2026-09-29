import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renameSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { Json, PluginManifest } from '@featherlog/contracts';
import { loadSettings, Settings } from './settings';
import { JsonFiles } from './storage';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

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
  const files = new JsonFiles({ now: () => 0, setTimeout(callback) {
    queueMicrotask(callback);
    return () => {};
  } });
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

it.each(['{broken', 'null', '{}', '{"shell":{},"plugins":[]}',
  '{"shell":{"paper":"aged"},"plugins":{"example":{"hour":24}}}']) (
  'backs up damaged settings verbatim before using defaults: %s', async contents => {
    const f = await fixture();
    const path = join(f.root, 'settings.json');
    await writeFile(path, contents);
    const clock = { now: () => 1234, setTimeout: () => () => {} };
    const recovered = loadSettings(f.root, f.manifests, f.files, f.log, clock);
    expect(recovered.all()).toEqual(f.settings.all());
    const backups = (await readdir(f.root)).filter(name => name.startsWith('settings.json.corrupt-1234-'));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(f.root, backups[0]!), 'utf8')).toBe(contents);
    expect(f.log.warn).toHaveBeenCalledOnce();
    await recovered.set('shell', 'paper', 'golden');
    expect(loadSettings(f.root, f.manifests, f.files, f.log, clock).all().shell!.paper).toBe('golden');
    expect(await readFile(join(f.root, backups[0]!), 'utf8')).toBe(contents);
  },
);

it('loads missing or valid settings without recovery and does not hide filesystem errors', async () => {
  const f = await fixture();
  const clock = { now: () => 0, setTimeout: () => () => {} };
  const load = () => loadSettings(f.root, f.manifests, f.files, f.log, clock);
  expect(load().all()).toEqual(f.settings.all());
  await f.settings.set('shell', 'compatMode', true);
  expect(load().all().shell!.compatMode).toBe(true);
  const invalidPath = join(f.root, 'settings.json');
  expect(() => loadSettings(invalidPath, f.manifests, f.files, f.log, clock)).toThrow();
  expect(f.log.warn).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual(['settings.json']);
});

it('preserves the original when backup fails and keeps manifest errors outside recovery', async () => {
  const f = await fixture();
  const path = join(f.root, 'settings.json');
  await writeFile(path, '{broken');
  const clock = { now: () => 0, setTimeout: () => () => {} };
  vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('backup denied'); });
  expect(() => loadSettings(f.root, f.manifests, f.files, f.log, clock)).toThrow('backup denied');
  expect(await readFile(path, 'utf8')).toBe('{broken');
  const invalid: PluginManifest[] = [{ id: 'bad', name: 'Bad', version: '1', contributes: {
    settings: { schema: { properties: { value: { type: 'integer', default: 'bad' } } } },
  } }];
  expect(() => loadSettings(f.root, invalid, f.files, f.log, clock))
    .toThrow(expect.objectContaining({ code: 'shell/invalid-setting' }));
  expect(await readdir(f.root)).toEqual(['settings.json']);
  expect(f.log.warn).not.toHaveBeenCalled();
});
