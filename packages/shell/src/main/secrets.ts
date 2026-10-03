import { safeStorage } from 'electron';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import type { Logger, PluginSecrets } from '@featherlog/contracts';
import type { Settings } from './settings';
import { JsonFiles } from './storage';
import { invalid } from './validation';

export class Secrets {
  private listeners = new Set<(scope: string, key: string) => void>();
  // ponytail: serialize secret edits; use per-key queues if concurrent edits become frequent.
  private queue = Promise.resolve();

  constructor(private userData: string, private settings: Settings,
    private files: JsonFiles, private log: Logger) {}

  private path(scope: string, key: string): string {
    if (typeof scope !== 'string' || typeof key !== 'string' ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(scope) || !this.settings.isSecret(scope, key)) {
      invalid('Only write-only string settings can store secrets', 'shell/invalid-setting');
    }
    return join(this.userData, 'secrets', scope, `${encodeURIComponent(key)}.json`);
  }

  private available(): void {
    // Linux's basic_text backend uses a hardcoded password, not a system secret store.
    if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' &&
      safeStorage.getSelectedStorageBackend() === 'basic_text') {
      invalid('System secret storage is unavailable; plaintext storage is disabled',
        'shell/secrets-unavailable');
    }
  }

  private async read(scope: string, key: string): Promise<Buffer | undefined> {
    const saved = await this.files.read(this.path(scope, key));
    if (saved === undefined) return undefined;
    if (typeof saved !== 'string' || saved.length === 0 ||
      Buffer.from(saved, 'base64').toString('base64') !== saved) {
      invalid('Invalid encrypted secret file', 'shell/storage-corrupt');
    }
    return Buffer.from(saved, 'base64');
  }

  async has(scope: string, key: string): Promise<boolean> {
    await this.queue;
    return await this.read(scope, key) !== undefined;
  }

  forPlugin(scope: string): PluginSecrets {
    return {
      get: async key => {
        await this.queue;
        const encrypted = await this.read(scope, key);
        if (encrypted === undefined) return undefined;
        this.available();
        try {
          return safeStorage.decryptString(encrypted);
        } catch {
          invalid('System secret storage could not decrypt the secret', 'shell/secrets-unavailable');
        }
      },
      onChange: listener => {
        const callback = (changed: string, key: string) => { if (changed === scope) listener(key); };
        this.listeners.add(callback);
        return () => { this.listeners.delete(callback); };
      },
    };
  }

  set(scope: string, key: string, value: string): Promise<void> {
    const operation = this.queue.then(async () => {
      const path = this.path(scope, key);
      if (typeof value !== 'string') invalid('Secret values must be strings', 'shell/invalid-setting');
      this.available();
      if (value === '') await this.files.delete(path);
      else {
        let encrypted: Buffer;
        try {
          encrypted = safeStorage.encryptString(value);
        } catch {
          // Native errors can contain input; never forward them to windows or logs.
          invalid('System secret storage could not encrypt the secret', 'shell/secrets-unavailable');
        }
        await this.files.write(path, encrypted.toString('base64'));
      }
      for (const listener of this.listeners) {
        try { listener(scope, key); }
        catch { this.log.error('Secret listener failed'); }
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  flush(): Promise<void> { return this.queue; }
}

export function registerSecretIpc(ipc: Pick<IpcMain, 'handle'>, secrets: Secrets,
  trusted: (event: IpcMainInvokeEvent) => boolean): void {
  const reply = async <T>(work: () => Promise<T>) => {
    try { return { value: await work() }; }
    catch (cause) {
      return { error: {
        code: cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
          ? cause.code : 'shell/settings-error',
        message: cause instanceof Error ? cause.message : String(cause),
      } };
    }
  };
  ipc.handle('settings:set-secret', (event, scope: unknown, key: unknown, value: unknown) => reply(async () => {
    if (!trusted(event) || typeof scope !== 'string' || typeof key !== 'string' || typeof value !== 'string') {
      invalid('Invalid secret request', 'shell/invalid-setting');
    }
    await secrets.set(scope, key, value);
    return null;
  }));
  ipc.handle('settings:has-secret', (event, scope: unknown, key: unknown) => reply(async () => {
    if (!trusted(event) || typeof scope !== 'string' || typeof key !== 'string') {
      invalid('Invalid secret request', 'shell/invalid-setting');
    }
    return secrets.has(scope, key);
  }));
}
