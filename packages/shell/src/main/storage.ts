import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Json, PluginStorage } from '@featherlog/contracts';
import { invalid, isJson } from './validation';

function missing(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

function parse(contents: string, file: string): Json {
  try {
    const value: unknown = JSON.parse(contents);
    if (isJson(value)) return value;
  } catch { /* Preserve the original file so users can recover their data. */ }
  return invalid(`Invalid JSON in ${file}`, 'shell/storage-corrupt');
}

export function readJsonSync(file: string): Json | undefined {
  try {
    return parse(readFileSync(file, 'utf8'), file);
  } catch (cause) {
    if (missing(cause)) return undefined;
    throw cause;
  }
}

export class JsonFiles {
  private pending = new Map<string, Promise<void>>();

  private enqueue(file: string, work: () => Promise<void>): Promise<void> {
    const result = (this.pending.get(file) ?? Promise.resolve()).then(work);
    const tail = result.catch(() => {});
    this.pending.set(file, tail);
    void tail.then(() => {
      if (this.pending.get(file) === tail) this.pending.delete(file);
    });
    return result;
  }

  async read(file: string): Promise<Json | undefined> {
    await this.pending.get(file);
    try {
      return parse(await readFile(file, 'utf8'), file);
    } catch (cause) {
      if (missing(cause)) return undefined;
      throw cause;
    }
  }

  write(file: string, value: Json): Promise<void> {
    if (!isJson(value)) return Promise.reject(Object.assign(new Error('Storage values must be JSON'), {
      code: 'shell/invalid-input',
    }));
    const contents = JSON.stringify(value);
    return this.enqueue(file, async () => {
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(contents, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(cause => {
          if (!missing(cause)) throw cause;
        });
      }
    });
  }

  delete(file: string): Promise<void> {
    return this.enqueue(file, async () => {
      await unlink(file).catch(cause => {
        if (!missing(cause)) throw cause;
      });
    });
  }

  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending.values());
  }
}

export function pluginStorage(userData: string, id: string, files: JsonFiles): PluginStorage {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) invalid('Invalid storage scope');
  const directory = join(userData, 'plugins', id);
  const path = (key: string) => join(directory, `${encodeURIComponent(key)}.json`);
  return {
    async get<T extends Json>(key: string) {
      return await files.read(path(key)) as T | undefined;
    },
    set: (key, value) => files.write(path(key), value),
    delete: key => files.delete(path(key)),
    async keys() {
      await files.flush();
      try {
        return (await readdir(directory)).filter(name => name.endsWith('.json'))
          .map(name => decodeURIComponent(name.slice(0, -5))).sort();
      } catch (cause) {
        if (missing(cause)) return [];
        throw cause;
      }
    },
  };
}
