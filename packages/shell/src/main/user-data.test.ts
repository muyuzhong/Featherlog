import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { configureUserData } from './user-data';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const electron = vi.hoisted(() => ({ app: {
  isPackaged: true,
  getPath: vi.fn<(name: string) => string>(),
  setName: vi.fn(), setPath: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => false), quit: vi.fn(),
} }));
vi.mock('electron', () => electron);
vi.mock('electron-updater', () => ({ default: {} }));
const directories: string[] = [];
afterEach(async () => {
  vi.mocked(renameSync).mockReset();
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(packaged = true) {
  const root = await mkdtemp(join(tmpdir(), 'featherlog-user-data-'));
  directories.push(root);
  const directory = join(root, 'Featherlog');
  const legacy = join(root, '@featherlog', 'shell');
  const development = join(root, 'Featherlog-dev');
  const app = electron.app;
  app.isPackaged = packaged;
  app.getPath.mockImplementation(name => {
    expect(name).toBe('appData');
    return root;
  });
  app.setPath.mockImplementation((name: string, path: string) => {
    expect(name).toBe('userData');
    expect(existsSync(path)).toBe(true);
  });
  const seed = (path = legacy) => {
    mkdirSync(join(path, 'plugins', 'quest'), { recursive: true });
    writeFileSync(join(path, 'plugins', 'quest', 'state.json'), '{"schemaVersion":1,"quests":[]}');
    writeFileSync(join(path, 'settings.json'), '{"shell":{"autoUpdate":false},"plugins":{}}');
    writeFileSync(join(path, 'other.bin'), Buffer.from([0, 255, 1]));
  };
  return { app, root, directory, legacy, development, seed };
}

it('uses Featherlog for a fresh packaged install and creates it before setPath', async () => {
  const { app, directory } = await fixture();
  expect(configureUserData(app)).toEqual({ migrationError: undefined });
  expect(app.setName).toHaveBeenCalledExactlyOnceWith('Featherlog');
  expect(app.setPath).toHaveBeenCalledExactlyOnceWith('userData', directory);
  expect(renameSync).not.toHaveBeenCalled();
});

it('uses Featherlog-dev without migrating or touching either production directory', async () => {
  const { app, directory, legacy, development, seed } = await fixture(false);
  seed();
  seed(directory);
  configureUserData(app);
  expect(app.setName).toHaveBeenCalledExactlyOnceWith('Featherlog');
  expect(app.setPath).toHaveBeenCalledExactlyOnceWith('userData', development);
  expect(renameSync).not.toHaveBeenCalled();
  expect(existsSync(legacy)).toBe(true);
  expect(existsSync(directory)).toBe(true);
  expect(readdirSync(development)).toEqual([]);
});

it('renames the complete legacy directory, preserving tasks, settings and other files', async () => {
  const { app, directory, legacy, seed } = await fixture();
  seed();
  const settings = readFileSync(join(legacy, 'settings.json'));
  const quests = readFileSync(join(legacy, 'plugins', 'quest', 'state.json'));
  expect(configureUserData(app)).toEqual({ migrationError: undefined });
  expect(renameSync).toHaveBeenCalledExactlyOnceWith(legacy, directory);
  expect(app.setPath).toHaveBeenCalledWith('userData', directory);
  expect(existsSync(legacy)).toBe(false);
  expect(readFileSync(join(directory, 'settings.json'))).toEqual(settings);
  expect(readFileSync(join(directory, 'plugins', 'quest', 'state.json'))).toEqual(quests);
  expect(readFileSync(join(directory, 'other.bin'))).toEqual(Buffer.from([0, 255, 1]));
});

it('never migrates over an existing target, even an empty one', async () => {
  const { app, directory, legacy, seed } = await fixture();
  seed();
  mkdirSync(directory);
  configureUserData(app);
  expect(app.setPath).toHaveBeenCalledWith('userData', directory);
  expect(renameSync).not.toHaveBeenCalled();
  expect(readdirSync(directory)).toEqual([]);
  expect(existsSync(join(legacy, 'settings.json'))).toBe(true);
});

it('falls back to the untouched legacy directory and returns the error for logging', async () => {
  const { app, directory, legacy, seed } = await fixture();
  seed();
  const cause = Object.assign(new Error('Directory in use'), { code: 'EPERM' });
  vi.mocked(renameSync).mockImplementationOnce(() => { throw cause; });
  expect(configureUserData(app).migrationError).toBe(cause);
  expect(app.setPath).toHaveBeenCalledExactlyOnceWith('userData', legacy);
  expect(existsSync(directory)).toBe(false);
  expect(readFileSync(join(legacy, 'other.bin'))).toEqual(Buffer.from([0, 255, 1]));
});

it('uses the migrated directory if a concurrent launch already moved the legacy directory', async () => {
  const { app, directory, seed } = await fixture();
  seed();
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementationOnce((from, to) => {
    actual.renameSync(from, to);
    throw Object.assign(new Error('Already moved'), { code: 'ENOENT' });
  });
  configureUserData(app);
  expect(app.setPath).toHaveBeenCalledExactlyOnceWith('userData', directory);
  expect(readFileSync(join(directory, 'other.bin'))).toEqual(Buffer.from([0, 255, 1]));
});

it('configures the startup directory before acquiring the single-instance lock', async () => {
  const { app, directory } = await fixture();
  app.requestSingleInstanceLock.mockImplementationOnce(() => {
    expect(app.setName).toHaveBeenCalledWith('Featherlog');
    expect(app.setPath).toHaveBeenCalledWith('userData', directory);
    return false;
  });
  await import('./index');
  expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
  expect(app.quit).toHaveBeenCalledOnce();
  // The losing process must not initialize services or read settings from a different directory.
  expect(app.getPath).toHaveBeenCalledExactlyOnceWith('appData');
});
