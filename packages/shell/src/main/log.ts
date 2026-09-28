import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import type { Clock, Logger } from '@featherlog/contracts';

export function createLogs(userData: string, clock: Clock) {
  let queue = Promise.resolve();
  const directory = join(userData, 'logs');
  const file = join(directory, 'main.log');
  const absent = (cause: unknown) => {
    if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause;
  };
  return {
    logger(scope: string): Logger {
      const write = (level: keyof Logger, message: string, data?: unknown) => {
        const line = `${new Date(clock.now()).toISOString()} ${level} [${scope}] ${message}` +
          (data === undefined ? '\n' : ` ${inspect(data, { depth: 4 })}\n`);
        console[level](line.trimEnd());
        queue = queue.then(async () => {
          await mkdir(directory, { recursive: true });
          const size = await stat(file).then(result => result.size, cause => {
            absent(cause);
            return 0;
          });
          if (size + Buffer.byteLength(line) > 1024 * 1024) {
            await unlink(`${file}.2`).catch(absent);
            await rename(`${file}.1`, `${file}.2`).catch(absent);
            await rename(file, `${file}.1`).catch(absent);
          }
          await appendFile(file, line, { mode: 0o600 });
        }).catch(cause => console.error('Could not write log', cause));
      };
      return {
        debug: (message, data) => write('debug', message, data),
        info: (message, data) => write('info', message, data),
        warn: (message, data) => write('warn', message, data),
        error: (message, data) => write('error', message, data),
      };
    },
    flush: () => queue,
  };
}
