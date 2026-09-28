import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from 'electron';

export function configureUserData(app: Pick<App, 'isPackaged' | 'getPath' | 'setName' | 'setPath'>) {
  app.setName('Featherlog');
  const root = app.getPath('appData');
  let directory = join(root, app.isPackaged ? 'Featherlog' : 'Featherlog-dev');
  const legacy = join(root, '@featherlog', 'shell');
  let migrationError: unknown;
  if (app.isPackaged && !existsSync(directory) && existsSync(legacy)) {
    try {
      renameSync(legacy, directory);
    } catch (cause) {
      migrationError = cause;
      // Another launch may have finished the migration before this rename ran.
      if (existsSync(legacy)) directory = legacy;
      else if (!existsSync(directory)) throw cause;
    }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  app.setPath('userData', directory);
  return { migrationError };
}
