import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { JsonFiles, pluginStorage, readJsonSync } from './storage';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.mocked(rename).mockReset();
  await Promise.all(directories.splice(0).map(path => rm(path, {
    recursive: true, force: true,
  })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'featherlog-storage-'));
  directories.push(root);
  let time = 0;
  const delays: number[] = [];
  const files = new JsonFiles({ now: () => time, setTimeout(callback, ms) {
    delays.push(ms);
    time += ms;
    queueMicrotask(callback);
    return () => {};
  } });
  return { root, files, delays, storage: pluginStorage(root, 'quest', files) };
}

it('isolates scopes, encodes keys, enumerates only JSON and supports deletion', async () => {
  const { root, files, storage } = await fixture();
  await expect(storage.set('invalid', NaN))
    .rejects.toMatchObject({ code: 'shell/invalid-input' });
  expect(await storage.get('missing')).toBeUndefined();
  expect(await storage.keys()).toEqual([]);
  await storage.set('../a / 测试', { value: 1 });
  const other = pluginStorage(root, 'other', files);
  expect(await other.get('../a / 测试')).toBeUndefined();
  await writeFile(join(root, 'plugins/quest/stale.tmp'), 'interrupted');
  expect(await storage.keys()).toEqual(['../a / 测试']);
  expect(await storage.get('../a / 测试')).toEqual({ value: 1 });
  await storage.delete('../a / 测试');
  await storage.delete('missing');
  expect(await storage.keys()).toEqual([]);
});

it('serializes same-key writes, snapshots arguments and atomically replaces complete JSON', async () => {
  const { root, files, storage } = await fixture();
  await storage.set('state', { old: true });
  const path = join(root, 'plugins/quest/state.json');
  const input = { value: 0, large: 'x'.repeat(100_000) };
  const first = storage.set('state', input);
  input.value = -1;
  const writes = Array.from({ length: 15 }, (_, value) => storage.set('state', { value }));
  for (let i = 0; i < 15; i++) {
    const observed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(observed.old === true || typeof observed.value === 'number').toBe(true);
  }
  await first;
  await Promise.all(writes);
  await files.flush();
  expect(await storage.get('state')).toEqual({ value: 14 });
  expect((await readdir(join(root, 'plugins/quest'))).some(name => name.endsWith('.tmp'))).toBe(false);
  await storage.set('copy', input);
  input.value = 999;
  expect(await storage.get('copy')).toMatchObject({ value: -1 });
});

it('preserves corrupt files and reports shell/storage-corrupt', async () => {
  const { root, storage } = await fixture();
  await mkdir(join(root, 'plugins/quest'), { recursive: true });
  const path = join(root, 'plugins/quest/state.json');
  await writeFile(path, '{broken');
  await expect(storage.get('state')).rejects.toMatchObject({ code: 'shell/storage-corrupt' });
  expect(() => readJsonSync(path)).toThrow(expect.objectContaining({ code: 'shell/storage-corrupt' }));
  expect(await readFile(path, 'utf8')).toBe('{broken');
});

it('cleans temporary files on failed rename and leaves the previous target intact', async () => {
  const { root, files } = await fixture();
  const path = join(root, 'target');
  await mkdir(path);
  await writeFile(join(path, 'keep'), 'original');
  await expect(files.write(path, { value: 1 })).rejects.toThrow();
  expect(await readFile(join(path, 'keep'), 'utf8')).toBe('original');
  expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  await files.flush();
});


it.each(['EPERM', 'EACCES', 'EBUSY'])(
  'retries transient %s with the same complete temporary file before queued writes', async code => {
    const { root, storage, files, delays } = await fixture();
    await storage.set('state', { old: true });
    const path = join(root, 'plugins/quest/state.json');
    const error = Object.assign(new Error('Target is busy'), { code });
    const locked = async (temporary: Parameters<typeof rename>[0]) => {
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ old: true });
      expect(JSON.parse(await readFile(temporary, 'utf8'))).toEqual({ value: 1 });
      throw error;
    };
    vi.mocked(rename).mockClear().mockImplementationOnce(locked).mockImplementationOnce(locked);
    const input = { value: 1 };
    const first = storage.set('state', input);
    input.value = -1;
    const second = storage.set('state', { value: 2 });
    await Promise.all([first, second, files.flush()]);
    expect(delays).toEqual([20, 40]);
    const calls = vi.mocked(rename).mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[1]).toEqual(calls[2]);
    expect(calls[3]![0]).not.toEqual(calls[0]![0]);
    expect(await storage.get('state')).toEqual({ value: 2 });
    expect(await readdir(join(root, 'plugins/quest'))).toEqual(['state.json']);
  },
);

it.each(['EPERM', 'EACCES', 'EBUSY'])(
  'exhausts %s retries, preserves the old file and removes the temporary file', async code => {
    const { root, storage, files, delays } = await fixture();
    await storage.set('state', { old: true });
    const error = Object.assign(new Error('Target remains busy'), { code });
    vi.mocked(rename).mockClear().mockRejectedValue(error);
    await expect(storage.set('state', { value: 1 })).rejects.toBe(error);
    expect(delays).toEqual([20, 40, 80, 160, 320, 380]);
    expect(delays.reduce((sum, ms) => sum + ms, 0)).toBe(1000);
    expect(rename).toHaveBeenCalledTimes(7);
    expect(await storage.get('state')).toEqual({ old: true });
    expect(await readdir(join(root, 'plugins/quest'))).toEqual(['state.json']);
    await files.flush();
    vi.mocked(rename).mockReset();
    await storage.set('state', { recovered: true });
    expect(await storage.get('state')).toEqual({ recovered: true });
  },
);

it.each(['ENOSPC', 'ENOENT', 'EXDEV'])(
  'does not retry %s and still cleans up the temporary file', async code => {
    const { root, storage, delays } = await fixture();
    await storage.set('state', { old: true });
    const error = Object.assign(new Error('Rename failed'), { code });
    vi.mocked(rename).mockClear().mockRejectedValue(error);
    await expect(storage.set('state', { value: 1 })).rejects.toBe(error);
    expect(rename).toHaveBeenCalledOnce();
    expect(delays).toEqual([]);
    expect(await storage.get('state')).toEqual({ old: true });
    expect(await readdir(join(root, 'plugins/quest'))).toEqual(['state.json']);
  },
);
