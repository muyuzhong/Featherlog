import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createLogs } from './log';

it('prefixes logs, uses the injected clock and rotates at 1 MB keeping three files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'featherlog-logs-'));
  const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    const directory = join(root, 'logs');
    await mkdir(directory);
    const file = join(directory, 'main.log');
    await writeFile(file, 'x'.repeat(1024 * 1024));
    await writeFile(`${file}.1`, 'older');
    await writeFile(`${file}.2`, 'oldest');
    const logs = createLogs(root, { now: () => 0, setTimeout: () => () => {} });
    logs.logger('quest').info('Ready');
    await logs.flush();
    expect(await readFile(file, 'utf8')).toBe('1970-01-01T00:00:00.000Z info [quest] Ready\n');
    expect(await readFile(`${file}.2`, 'utf8')).toBe('older');
    expect((await readFile(`${file}.1`, 'utf8')).length).toBe(1024 * 1024);
    expect((await readdir(directory)).sort()).toEqual(['main.log', 'main.log.1', 'main.log.2']);
    expect(spy).toHaveBeenCalledOnce();
  } finally {
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
