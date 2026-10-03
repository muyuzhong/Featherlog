import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createKernel } from '@featherlog/kernel';
import type { Envelope, MainContext, PluginManifest } from '@featherlog/contracts';
import { Secrets, registerSecretIpc } from './secrets';
import { Settings } from './settings';
import { JsonFiles, pluginStorage } from './storage';

vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: vi.fn(), getSelectedStorageBackend: vi.fn(),
  encryptString: vi.fn(), decryptString: vi.fn(),
} }));

const directories: string[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
  vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('kwallet6');
  const plaintext = new Map<string, string>();
  vi.mocked(safeStorage.encryptString).mockImplementation(value => {
    const encrypted = Buffer.from(`ciphertext-${plaintext.size}`);
    plaintext.set(encrypted.toString('base64'), value);
    return encrypted;
  });
  vi.mocked(safeStorage.decryptString).mockImplementation(encrypted => {
    const value = plaintext.get(encrypted.toString('base64'));
    if (value === undefined) throw new Error('Unknown ciphertext');
    return value;
  });
});
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'featherlog-secrets-'));
  directories.push(root);
  const manifests: PluginManifest[] = ['alpha', 'beta'].map(id => ({ id, name: id, version: '1',
    contributes: { settings: { schema: { type: 'object', properties: {
      apiKey: { type: 'string', writeOnly: true, default: 'ignored-secret-default' },
      'nested/key': { type: 'string', writeOnly: true },
      endpoint: { type: 'string', default: 'https://example.test' },
      broken: { type: 'boolean', writeOnly: true, default: true },
    } } } },
  }));
  const clock = { now: () => 0, setTimeout: () => () => {} };
  const files = new JsonFiles(clock);
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const settings = new Settings(root, manifests, undefined, files, log);
  const secrets = new Secrets(root, settings, files, log);
  return { root, manifests, clock, files, log, settings, secrets };
}

it('encrypts, persists and reloads secrets in shell storage isolated from plugin storage and settings', async () => {
  const { root, settings, secrets, files, log } = await fixture();
  expect(settings.all().alpha).toEqual({ endpoint: 'https://example.test' });
  expect(settings.forPlugin('alpha').get('apiKey')).toBeUndefined();
  await expect(secrets.forPlugin('alpha').get('apiKey')).resolves.toBeUndefined();
  await expect(secrets.has('alpha', 'apiKey')).resolves.toBe(false);
  await secrets.set('alpha', 'apiKey', 'alpha-private-key');
  await secrets.set('beta', 'apiKey', 'beta-private-key');
  expect(safeStorage.encryptString).toHaveBeenCalledWith('alpha-private-key');
  const contents = await readFile(join(root, 'secrets', 'alpha', 'apiKey.json'), 'utf8');
  expect(JSON.parse(contents)).toBe(Buffer.from('ciphertext-0').toString('base64'));
  expect(contents).not.toContain('alpha-private-key');
  const reloaded = new Secrets(root, settings, files, log);
  await expect(reloaded.forPlugin('alpha').get('apiKey')).resolves.toBe('alpha-private-key');
  await expect(reloaded.forPlugin('beta').get('apiKey')).resolves.toBe('beta-private-key');
  await expect(pluginStorage(root, 'alpha', files).keys()).resolves.toEqual([]);
  await expect(reloaded.has('alpha', 'apiKey')).resolves.toBe(true);
  await settings.set('alpha', 'endpoint', 'https://other.test');
  const publicFile = await readFile(join(root, 'settings.json'), 'utf8');
  expect(publicFile).not.toContain('apiKey');
  expect(publicFile).not.toContain('private-key');
  expect(settings.forPlugin('alpha').get('apiKey')).toBeUndefined();
  expect(JSON.stringify(settings.all())).not.toContain('apiKey');
});

it.each([['alpha', 'endpoint'], ['alpha', 'broken'], ['alpha', 'unknown'],
  ['unknown', 'apiKey'], ['shell', 'paper'], ['__proto__', 'apiKey'], ['alpha', '__proto__']])(
  'rejects non-secret %s/%s for writes, presence queries and plugin reads', async (scope, key) => {
    const { root, secrets } = await fixture();
    await expect(secrets.set(scope!, key!, 'value')).rejects.toMatchObject({ code: 'shell/invalid-setting' });
    await expect(secrets.has(scope!, key!)).rejects.toMatchObject({ code: 'shell/invalid-setting' });
    await expect(secrets.forPlugin(scope!).get(key!)).rejects.toMatchObject({ code: 'shell/invalid-setting' });
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  },
);

it('rejects ordinary setting writes to secrets and strips saved write-only values from public settings', async () => {
  const { root, settings, files, log, manifests } = await fixture();
  const listener = vi.fn();
  settings.onChange(listener);
  await expect(settings.set('alpha', 'apiKey', 'private-key'))
    .rejects.toMatchObject({ code: 'shell/invalid-setting' });
  expect(listener).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
  const loaded = new Settings(root, manifests, { shell: {}, plugins: {
    alpha: { apiKey: 'legacy-plaintext', endpoint: 'https://saved.test' },
  } }, files, log);
  expect(loaded.all().alpha).toEqual({ endpoint: 'https://saved.test' });
  expect(loaded.forPlugin('alpha').get('apiKey')).toBeUndefined();
  await loaded.set('alpha', 'endpoint', 'https://updated.test');
  expect(await readFile(join(root, 'settings.json'), 'utf8')).not.toContain('legacy-plaintext');
});

it('deletes on an empty string and notifies only that plugin with the key, outside public settings and the bus', async () => {
  const f = await fixture();
  const kernel = createKernel({ clock: f.clock, log: f.log, createServices: id => ({
    clock: f.clock, log: f.log, storage: pluginStorage(f.root, id, f.files),
    settings: f.settings.forPlugin(id), secrets: f.secrets.forPlugin(id),
  }) });
  const messages: Envelope[] = [];
  kernel.observe(message => messages.push(message));
  const alpha = vi.fn();
  const beta = vi.fn();
  let context!: MainContext;
  await kernel.load(f.manifests.map(manifest => ({ manifest, setup: ctx => {
    ctx.secrets.onChange(manifest.id === 'alpha' ? alpha : beta);
    if (manifest.id === 'alpha') context = ctx;
  } })));
  messages.length = 0;
  const windows = vi.fn();
  const publicPlugin = vi.fn();
  f.settings.onChange(windows);
  f.settings.forPlugin('alpha').onChange(publicPlugin);
  await f.secrets.set('alpha', 'apiKey', 'private-key');
  expect(alpha.mock.calls).toEqual([['apiKey']]);
  expect(beta).not.toHaveBeenCalled();
  await expect(context.secrets.get('apiKey')).resolves.toBe('private-key');
  await f.secrets.set('alpha', 'apiKey', '');
  await expect(f.secrets.has('alpha', 'apiKey')).resolves.toBe(false);
  await expect(context.secrets.get('apiKey')).resolves.toBeUndefined();
  expect(await readdir(join(f.root, 'secrets', 'alpha'))).toEqual([]);
  expect(alpha.mock.calls).toEqual([['apiKey'], ['apiKey']]);
  kernel.unload('alpha');
  messages.length = 0;
  await f.secrets.set('alpha', 'apiKey', 'replacement');
  expect(alpha).toHaveBeenCalledTimes(2);
  expect(windows).not.toHaveBeenCalled();
  expect(publicPlugin).not.toHaveBeenCalled();
  expect(messages).toEqual([]);
});

it('refuses writes and decryption without system encryption, preserves saved ciphertext and never falls back', async () => {
  const { root, secrets } = await fixture();
  await secrets.set('alpha', 'apiKey', 'private-key');
  const path = join(root, 'secrets', 'alpha', 'apiKey.json');
  const original = await readFile(path, 'utf8');
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
  for (const value of ['replacement', '']) {
    await expect(secrets.set('alpha', 'apiKey', value))
      .rejects.toMatchObject({ code: 'shell/secrets-unavailable' });
  }
  await expect(secrets.forPlugin('alpha').get('apiKey'))
    .rejects.toMatchObject({ code: 'shell/secrets-unavailable' });
  await expect(secrets.has('alpha', 'apiKey')).resolves.toBe(true);
  expect(await readFile(path, 'utf8')).toBe(original);
  expect(safeStorage.encryptString).toHaveBeenCalledOnce();
  expect(safeStorage.decryptString).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'linux')('refuses the Linux basic_text backend even when encryption claims availability', async () => {
  const { root, secrets } = await fixture();
  vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('basic_text');
  await expect(secrets.set('alpha', 'apiKey', 'private-key'))
    .rejects.toMatchObject({ code: 'shell/secrets-unavailable' });
  expect(safeStorage.encryptString).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});

it('does not notify on encryption or disk failure, sanitizes native errors and recovers the write queue', async () => {
  const { secrets, files, log } = await fixture();
  const listener = vi.fn();
  secrets.forPlugin('alpha').onChange(listener);
  vi.mocked(safeStorage.encryptString).mockImplementationOnce(() => { throw new Error('private-key'); });
  const error = await secrets.set('alpha', 'apiKey', 'private-key').catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: 'shell/secrets-unavailable' });
  expect(String(error)).not.toContain('private-key');
  expect(listener).not.toHaveBeenCalled();
  vi.spyOn(files, 'write').mockRejectedValueOnce(new Error('disk full'));
  await expect(secrets.set('alpha', 'apiKey', 'private-key')).rejects.toThrow('disk full');
  expect(listener).not.toHaveBeenCalled();
  await expect(secrets.has('alpha', 'apiKey')).resolves.toBe(false);
  const off = secrets.forPlugin('alpha').onChange(() => { throw new Error('private-key'); });
  await secrets.set('alpha', 'apiKey', 'private-key');
  expect(listener.mock.calls).toEqual([['apiKey']]);
  expect(log.error.mock.calls).toEqual([['Secret listener failed']]);
  off();
  vi.mocked(safeStorage.decryptString).mockImplementationOnce(() => { throw new Error('private-key'); });
  await expect(secrets.forPlugin('alpha').get('apiKey'))
    .rejects.toThrow(expect.objectContaining({ code: 'shell/secrets-unavailable',
      message: 'System secret storage could not decrypt the secret' }));
});

it.each(['null', '"not base64"', '""', '{broken'])(
  'preserves corrupt ciphertext instead of treating it as plaintext: %s', async contents => {
    const { root, secrets } = await fixture();
    await secrets.set('alpha', 'apiKey', 'private-key');
    const path = join(root, 'secrets', 'alpha', 'apiKey.json');
    await writeFile(path, contents);
    await expect(secrets.forPlugin('alpha').get('apiKey'))
      .rejects.toMatchObject({ code: 'shell/storage-corrupt' });
    expect(await readFile(path, 'utf8')).toBe(contents);
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
  },
);

it('serializes queued updates and deletion, supports encoded keys and waits for writes before reads and flush', async () => {
  const { secrets } = await fixture();
  const first = secrets.set('alpha', 'nested/key', 'first');
  const second = secrets.set('alpha', 'nested/key', 'second');
  const reading = secrets.forPlugin('alpha').get('nested/key');
  await secrets.flush();
  await Promise.all([first, second]);
  await expect(reading).resolves.toBe('second');
  const deleting = secrets.set('alpha', 'nested/key', '');
  await expect(secrets.has('alpha', 'nested/key')).resolves.toBe(false);
  await deleting;
});

it('accepts secret IPC only from trusted windows with valid arguments and returns only presence or JSON errors', async () => {
  const { secrets } = await fixture();
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipc = { handle: vi.fn((channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => { handlers.set(channel, handler); }) };
  const trusted = {} as IpcMainInvokeEvent;
  const untrusted = {} as IpcMainInvokeEvent;
  registerSecretIpc(ipc, secrets, event => event === trusted);
  const set = handlers.get('settings:set-secret')!;
  const has = handlers.get('settings:has-secret')!;
  for (const args of [[untrusted, 'alpha', 'apiKey', 'private-key'],
    [trusted, null, 'apiKey', 'private-key'], [trusted, 'alpha', [], 'private-key'],
    [trusted, 'alpha', 'apiKey', 1], [trusted, 'alpha', 'endpoint', 'private-key']]) {
    const [event, ...values] = args;
    await expect(set(event as IpcMainInvokeEvent, ...values))
      .resolves.toMatchObject({ error: { code: 'shell/invalid-setting' } });
  }
  await expect(has(untrusted, 'alpha', 'apiKey')).resolves.toMatchObject({ error: { code: 'shell/invalid-setting' } });
  await expect(has(trusted, 'alpha', null)).resolves.toMatchObject({ error: { code: 'shell/invalid-setting' } });
  await expect(has(trusted, 'alpha', 'endpoint')).resolves.toMatchObject({ error: { code: 'shell/invalid-setting' } });
  expect(safeStorage.encryptString).not.toHaveBeenCalled();
  await expect(set(trusted, 'alpha', 'apiKey', 'private-key')).resolves.toEqual({ value: null });
  await expect(has(trusted, 'alpha', 'apiKey')).resolves.toEqual({ value: true });
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
  await expect(set(trusted, 'alpha', 'apiKey', 'replacement'))
    .resolves.toMatchObject({ error: { code: 'shell/secrets-unavailable' } });
});
