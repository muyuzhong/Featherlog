import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { access, lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Bus, BusErrorInfo, Clock, Dispose, Json, Logger, MainContext, PluginDescriptor,
  PluginManifest, PluginSetup,
} from '@featherlog/contracts';
import type { Kernel, MainPlugin } from '@featherlog/kernel';
import type { Settings } from './settings';
import { JsonFiles, readJsonSync } from './storage';
import { invalid, isJson, record } from './validation';
import type { ProtocolRequestLike } from './shared-protocol';

export const PLUGIN_PROTOCOL = 'featherlog-plugin';
export const PLUGIN_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const RESERVED_PLUGIN_IDS = new Set(['kernel', 'shell', 'external']);

const WATCHED_PLUGIN_FILES = new Set(['manifest.json', 'main.js', 'ui.js']);
const FORBIDDEN_PROTOCOL_BASENAMES = new Set(['manifest.json', 'main.js', 'main.js.map']);
const PROTOCOL_MIME_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface WatcherLike {
  close(): void;
  on?(event: 'error', listener: (error: Error) => void): void;
}

export interface ExternalPluginManagerOptions {
  userData: string;
  builtinPlugins: readonly MainPlugin[];
  kernel: Kernel;
  shellBus: Bus;
  settings: Settings;
  files: JsonFiles;
  clock: Clock;
  log: Logger;
  debounceMs?: number;
  importTimeoutMs?: number;
  importModule?: (specifier: string) => Promise<Record<string, unknown>>;
  watchDir?: (dir: string, listener: (eventType: string, filename: string | null) => void) => WatcherLike;
}

interface ExternalEntry {
  manifest: PluginManifest;
  uiRel?: string;
  enabled: boolean;
  status: 'loaded' | 'disabled' | 'failed';
  loadedInKernel: boolean;
  uiUrl?: string;
  error?: BusErrorInfo;
}

type DiscoveryResult =
  | { kind: 'ignore' }
  | { kind: 'conflict'; id: string; error: BusErrorInfo }
  | { kind: 'invalid'; id: string; manifest?: PluginManifest; error: BusErrorInfo }
  | { kind: 'disabled'; id: string; manifest: PluginManifest; uiRel?: string }
  | { kind: 'ready'; id: string; manifest: PluginManifest; mainReal: string; uiRel?: string };

export function isWithin(parentReal: string, childReal: string): boolean {
  const rel = relative(parentReal, childReal);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function normalizeRelPath(rawPath: string): string {
  if (!rawPath || rawPath.includes('\0') || rawPath.includes('\\')) {
    invalid('Illegal external plugin relative path', 'shell/path-outside-root');
  }
  const stripped = rawPath.replace(/^\/+/, '').replace(/^(?:\.\/)+/, '');
  if (!stripped) invalid('Empty external plugin relative path', 'shell/invalid-manifest');
  const segments = stripped.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    invalid(`Disallowed path traversal segment in "${rawPath}"`, 'shell/path-outside-root');
  }
  return segments.join('/');
}

function isAllowedUiRelPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  const base = lower.split('/').at(-1) ?? '';
  if (FORBIDDEN_PROTOCOL_BASENAMES.has(base)) return false;
  if (lower.endsWith('.json') || lower.endsWith('.tmp')) return false;
  return Object.hasOwn(PROTOCOL_MIME_TYPES, extname(lower));
}

async function resolvePluginDir(pluginsRootReal: string, pluginId: string): Promise<string> {
  const dirReal = await realpath(join(pluginsRootReal, pluginId));
  if (!isWithin(pluginsRootReal, dirReal)) {
    invalid(`External plugin directory "${pluginId}" escapes plugins root`, 'shell/path-outside-root');
  }
  const dirStat = await stat(dirReal);
  if (!dirStat.isDirectory()) {
    invalid(`External plugin "${pluginId}" is not a directory`, 'shell/invalid-manifest');
  }
  return dirReal;
}

export async function resolveContainedFile(
  pluginsRootReal: string,
  pluginId: string,
  rawRelPath: string,
): Promise<{ dirReal: string; fileReal: string; relPath: string }> {
  if (!PLUGIN_ID_RE.test(pluginId)) {
    invalid(`Invalid external plugin id "${pluginId}"`, 'shell/invalid-plugin-id');
  }
  const relPath = normalizeRelPath(rawRelPath);
  const dirReal = await resolvePluginDir(pluginsRootReal, pluginId);
  const fileReal = await realpath(resolve(dirReal, relPath));
  if (!isWithin(pluginsRootReal, fileReal) || !isWithin(dirReal, fileReal)) {
    invalid(`File "${relPath}" escapes plugin directory "${pluginId}"`, 'shell/path-outside-root');
  }
  const fileStat = await stat(fileReal);
  if (!fileStat.isFile()) {
    invalid(`Entry "${relPath}" is not a file`, 'shell/invalid-manifest');
  }
  return { dirReal, fileReal, relPath };
}

function toErrorInfo(cause: unknown, fallbackCode = 'shell/plugin-failed'): BusErrorInfo {
  if (cause instanceof Error) {
    const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : fallbackCode;
    return { code, message: cause.message };
  }
  return { code: fallbackCode, message: String(cause) };
}

function validateManifestObject(
  raw: unknown,
  expectedId: string,
  builtinIds: ReadonlySet<string>,
): PluginManifest {
  if (!record(raw) || !isJson(raw)) {
    invalid('Manifest must be a JSON object', 'shell/invalid-manifest');
  }
  if (typeof raw.id !== 'string' || !PLUGIN_ID_RE.test(raw.id)) {
    invalid(`Invalid external plugin id in manifest for "${expectedId}"`, 'shell/invalid-plugin-id');
  }
  if (raw.id !== expectedId) {
    invalid(`Manifest id "${raw.id}" does not match folder "${expectedId}"`, 'shell/invalid-manifest');
  }
  if (RESERVED_PLUGIN_IDS.has(raw.id)) {
    invalid(`External plugin id "${raw.id}" is reserved`, 'shell/reserved-plugin-id');
  }
  if (builtinIds.has(raw.id)) {
    invalid(`External plugin "${raw.id}" conflicts with a built-in plugin`, 'shell/plugin-conflict');
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    invalid(`External plugin "${expectedId}" is missing a valid name`, 'shell/invalid-manifest');
  }
  if (typeof raw.version !== 'string' || !raw.version.trim()) {
    invalid(`External plugin "${expectedId}" is missing a valid version`, 'shell/invalid-manifest');
  }
  if (raw.main !== undefined && (typeof raw.main !== 'string' || !raw.main.trim())) {
    invalid(`External plugin "${expectedId}" has an invalid main entry`, 'shell/invalid-manifest');
  }
  if (raw.ui !== undefined && (typeof raw.ui !== 'string' || !raw.ui.trim())) {
    invalid(`External plugin "${expectedId}" has an invalid ui entry`, 'shell/invalid-manifest');
  }
  return structuredClone(raw) as unknown as PluginManifest;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class ExternalPluginManager {
  private readonly pluginsDir: string;
  private readonly stateFile: string;
  private readonly builtinIds: Set<string>;
  private readonly disabledIds = new Set<string>();
  private readonly entries = new Map<string, ExternalEntry>();
  private readonly disposers: Dispose[] = [];
  private readonly importModule: (specifier: string) => Promise<Record<string, unknown>>;
  private readonly watchDir: (
    dir: string,
    listener: (eventType: string, filename: string | null) => void,
  ) => WatcherLike;
  private readonly debounceMs: number;
  private readonly importTimeoutMs: number;
  private pluginsRootReal?: string;
  private loadSeq = 0;
  private watcher?: WatcherLike;
  private debounceCancel?: Dispose;
  private pendingIds = new Set<string>();
  private reloadAllPending = false;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: ExternalPluginManagerOptions) {
    this.pluginsDir = join(options.userData, 'plugins');
    this.stateFile = join(options.userData, 'external-plugins.json');
    this.builtinIds = new Set(options.builtinPlugins.map(plugin => plugin.manifest.id));
    this.debounceMs = options.debounceMs ?? 150;
    this.importTimeoutMs = options.importTimeoutMs ?? 10_000;
    this.importModule = options.importModule ?? (specifier => import(specifier) as Promise<Record<string, unknown>>);
    this.watchDir = options.watchDir ?? ((dir, listener) => watch(dir, { recursive: true }, listener) as FSWatcher);
    this.readDisabledState();

    this.disposers.push(
      options.shellBus.handle('shell/plugins', () => this.list()),
      options.shellBus.handle('shell/reload-plugins', ({ id }) => this.reload(id)),
      options.shellBus.handle('shell/set-plugin-enabled', ({ id, enabled }) => this.setEnabled(id, enabled)),
    );
  }

  private readDisabledState(): void {
    try {
      const raw = readJsonSync(this.stateFile);
      if (!record(raw) || !Array.isArray(raw.disabled)) return;
      for (const item of raw.disabled) {
        if (typeof item === 'string' && PLUGIN_ID_RE.test(item) && !this.builtinIds.has(item)) {
          this.disabledIds.add(item);
        }
      }
    } catch (cause) {
      this.options.log.warn('Ignoring unreadable external plugin state; treating all as enabled', { cause });
    }
  }

  private async writeDisabledState(): Promise<void> {
    await this.options.files.write(this.stateFile, {
      disabled: [...this.disabledIds].sort(),
    });
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async ensurePluginsRoot(): Promise<string> {
    if (!this.pluginsRootReal) {
      await mkdir(this.pluginsDir, { recursive: true });
      this.pluginsRootReal = await realpath(this.pluginsDir);
    }
    return this.pluginsRootReal;
  }

  list(): PluginDescriptor[] {
    const builtins: PluginDescriptor[] = this.options.builtinPlugins.map(plugin => ({
      manifest: structuredClone(plugin.manifest),
      source: 'builtin',
      enabled: true,
      status: 'loaded',
    }));
    const externals: PluginDescriptor[] = [...this.entries.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, entry]) => ({
        manifest: structuredClone(entry.manifest),
        source: 'external',
        enabled: entry.enabled,
        status: entry.status,
        ...(entry.uiUrl ? { uiUrl: entry.uiUrl } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      }));
    return [...builtins, ...externals];
  }

  loadedIds(): string[] {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.loadedInKernel)
      .map(([id]) => id);
  }

  private emitPluginFailed(pluginId: string, error: BusErrorInfo): void {
    this.options.kernel.inject({
      v: 1,
      id: randomUUID(),
      kind: 'event',
      type: 'kernel/plugin-failed',
      source: 'kernel',
      time: this.options.clock.now(),
      payload: { pluginId, error },
    });
  }

  private emitPluginsChanged(reloadedIds: string[], removedIds: string[]): void {
    this.options.shellBus.emit('shell/plugins-changed', {
      plugins: this.list(),
      ...(reloadedIds.length > 0 ? { reloadedIds } : {}),
      ...(removedIds.length > 0 ? { removedIds } : {}),
    });
  }

  private fallbackManifest(id: string): PluginManifest {
    const existing = this.entries.get(id)?.manifest;
    if (existing) return existing;
    return { id, name: id, version: '0.0.0' };
  }

  private async discoverEntry(entryName: string, pluginsRootReal: string): Promise<DiscoveryResult> {
    const rawDir = join(pluginsRootReal, entryName);
    let rootLstat;
    try {
      rootLstat = await lstat(rawDir);
    } catch {
      return { kind: 'ignore' };
    }
    const manifestCandidate = join(rawDir, 'manifest.json');
    if (!(await fileExists(manifestCandidate))) {
      // Built-in plugin storage directories (quest/scribe/notes) live alongside external plugins here.
      return { kind: 'ignore' };
    }

    if (this.builtinIds.has(entryName)) {
      return {
        kind: 'conflict',
        id: entryName,
        error: {
          code: 'shell/plugin-conflict',
          message: `External plugin "${entryName}" conflicts with a built-in plugin`,
        },
      };
    }

    if (!rootLstat.isDirectory() && !rootLstat.isSymbolicLink()) {
      return { kind: 'ignore' };
    }

    let parsedManifest: PluginManifest | undefined;
    try {
      const { fileReal: manifestReal } = await resolveContainedFile(pluginsRootReal, entryName, 'manifest.json');
      const rawJson = JSON.parse(await readFile(manifestReal, 'utf8')) as Json;
      parsedManifest = validateManifestObject(rawJson, entryName, this.builtinIds);

      const mainRel = parsedManifest.main ?? 'main.js';
      const uiExplicit = parsedManifest.ui;
      let uiRel: string | undefined;
      if (uiExplicit !== undefined) {
        const uiResolved = await resolveContainedFile(pluginsRootReal, parsedManifest.id, uiExplicit);
        if (!isAllowedUiRelPath(uiResolved.relPath)) {
          invalid(`Disallowed UI entry "${uiExplicit}"`, 'shell/path-outside-root');
        }
        uiRel = uiResolved.relPath;
      } else {
        const defaultUiPath = join(pluginsRootReal, parsedManifest.id, 'ui.js');
        if (await fileExists(defaultUiPath)) {
          const uiResolved = await resolveContainedFile(pluginsRootReal, parsedManifest.id, 'ui.js');
          uiRel = uiResolved.relPath;
        }
      }

      if (this.disabledIds.has(parsedManifest.id)) {
        return { kind: 'disabled', id: parsedManifest.id, manifest: parsedManifest, uiRel };
      }

      const mainResolved = await resolveContainedFile(pluginsRootReal, parsedManifest.id, mainRel);
      return { kind: 'ready', id: parsedManifest.id, manifest: parsedManifest, mainReal: mainResolved.fileReal, uiRel };
    } catch (cause) {
      return {
        kind: 'invalid',
        id: entryName,
        ...(parsedManifest ? { manifest: parsedManifest } : {}),
        error: toErrorInfo(cause, 'shell/invalid-manifest'),
      };
    }
  }

  private async importEntryModule(specifier: string, id: string): Promise<PluginSetup<MainContext>> {
    let cancelTimer: Dispose = () => {};
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      cancelTimer = this.options.clock.setTimeout(() => {
        timedOut = true;
        reject(Object.assign(new Error(`External plugin "${id}" import timed out`), { code: 'shell/timeout' }));
      }, this.importTimeoutMs);
    });
    try {
      const loaded = await Promise.race([this.importModule(specifier), timeout]);
      if (typeof loaded.setup !== 'function') {
        invalid(`External plugin "${id}" main entry must export setup(ctx)`, 'shell/invalid-entry');
      }
      return loaded.setup as PluginSetup<MainContext>;
    } catch (cause) {
      if (timedOut) {
        throw invalid(`External plugin "${id}" import timed out`, 'shell/timeout');
      }
      throw cause;
    } finally {
      cancelTimer();
    }
  }

  private unloadFromKernel(id: string): void {
    const existing = this.entries.get(id);
    if (existing?.loadedInKernel) {
      this.options.kernel.unload(id);
      existing.loadedInKernel = false;
    }
    this.options.settings.unregisterPlugin(id);
  }

  private async applyDiscoveries(results: DiscoveryResult[]): Promise<void> {
    const mainPlugins: MainPlugin[] = [];
    const staged = new Map<string, { manifest: PluginManifest; uiUrl?: string }>();

    for (const item of results) {
      if (item.kind === 'ignore') continue;
      if (item.kind === 'conflict') {
        this.options.log.error('Skipped conflicting external plugin', item.error);
        this.emitPluginFailed(item.id, item.error);
        continue;
      }
      if (item.kind === 'disabled') {
        this.entries.set(item.id, {
          manifest: item.manifest,
          ...(item.uiRel ? { uiRel: item.uiRel } : {}),
          enabled: false,
          status: 'disabled',
          loadedInKernel: false,
        });
        continue;
      }
      if (item.kind === 'invalid') {
        this.options.log.error('External plugin failed validation', { id: item.id, error: item.error });
        this.entries.set(item.id, {
          manifest: item.manifest ?? this.fallbackManifest(item.id),
          enabled: true,
          status: 'failed',
          loadedInKernel: false,
          error: item.error,
        });
        this.emitPluginFailed(item.id, item.error);
        continue;
      }

      const token = `${this.options.clock.now()}-${++this.loadSeq}`;
      const mainUrl = `${pathToFileURL(item.mainReal).href}?v=${token}`;
      try {
        this.options.settings.registerPlugin(item.manifest);
        const setup = await this.importEntryModule(mainUrl, item.id);
        const uiUrl = item.uiRel ? `${PLUGIN_PROTOCOL}://${item.id}/${item.uiRel}?v=${token}` : undefined;
        mainPlugins.push({ manifest: item.manifest, setup });
        staged.set(item.id, { manifest: item.manifest, ...(uiUrl ? { uiUrl } : {}) });
      } catch (cause) {
        this.options.settings.unregisterPlugin(item.id);
        const error = toErrorInfo(cause, 'shell/plugin-failed');
        this.options.log.error('External plugin failed to import or register', { id: item.id, error });
        this.entries.set(item.id, {
          manifest: item.manifest,
          enabled: true,
          status: 'failed',
          loadedInKernel: false,
          error,
        });
        this.emitPluginFailed(item.id, error);
      }
    }

    if (mainPlugins.length === 0) return;

    const kernelFailures = new Map<string, BusErrorInfo>();
    const off = this.options.kernel.createBus('shell').on('kernel/plugin-failed', ({ pluginId, error }) => {
      if (staged.has(pluginId)) {
        kernelFailures.set(pluginId, error);
      }
    });
    try {
      await this.options.kernel.load(mainPlugins);
    } finally {
      off();
    }

    for (const [id, meta] of staged) {
      const failure = kernelFailures.get(id);
      if (failure) {
        this.options.settings.unregisterPlugin(id);
        this.options.log.error('External plugin setup failed', { id, error: failure });
        this.entries.set(id, {
          manifest: meta.manifest,
          enabled: true,
          status: 'failed',
          loadedInKernel: false,
          error: failure,
        });
      } else {
        this.entries.set(id, {
          manifest: meta.manifest,
          enabled: true,
          status: 'loaded',
          loadedInKernel: true,
          ...(meta.uiUrl ? { uiUrl: meta.uiUrl } : {}),
        });
      }
    }
  }

  async loadAll(): Promise<void> {
    await this.runSerialized(async () => {
      if (this.disposed) return;
      const rootReal = await this.ensurePluginsRoot();
      const dirEntries = (await readdir(rootReal)).sort((a, b) => a.localeCompare(b));
      const discovered: DiscoveryResult[] = [];
      for (const name of dirEntries) {
        discovered.push(await this.discoverEntry(name, rootReal));
      }
      await this.applyDiscoveries(discovered);
    });
  }

  async reload(targetId?: string): Promise<PluginDescriptor[]> {
    return await this.runSerialized(async () => {
      if (this.disposed) return this.list();
      const rootReal = await this.ensurePluginsRoot();
      const reloadedIds: string[] = [];
      const removedIds: string[] = [];

      if (targetId !== undefined) {
        if (this.builtinIds.has(targetId) || RESERVED_PLUGIN_IDS.has(targetId)) {
          invalid(`Cannot reload non-external plugin "${targetId}"`);
        }
        const hadExisting = this.entries.has(targetId);
        if (hadExisting) this.unloadFromKernel(targetId);
        const discovered = await this.discoverEntry(targetId, rootReal);
        if (discovered.kind === 'ignore') {
          if (hadExisting) {
            this.entries.delete(targetId);
            removedIds.push(targetId);
          }
        } else {
          await this.applyDiscoveries([discovered]);
          if (discovered.kind !== 'conflict') reloadedIds.push(targetId);
        }
        if (reloadedIds.length > 0 || removedIds.length > 0) {
          this.emitPluginsChanged(reloadedIds, removedIds);
        }
        return this.list();
      }

      const diskNames = new Set((await readdir(rootReal)).sort((a, b) => a.localeCompare(b)));
      const allIds = [...new Set([...this.entries.keys(), ...diskNames])].sort((a, b) => a.localeCompare(b));
      const toApply: DiscoveryResult[] = [];
      for (const id of allIds) {
        const hadExisting = this.entries.has(id);
        if (hadExisting) this.unloadFromKernel(id);
        const discovered = diskNames.has(id)
          ? await this.discoverEntry(id, rootReal)
          : ({ kind: 'ignore' } as const);
        if (discovered.kind === 'ignore') {
          if (hadExisting) {
            this.entries.delete(id);
            removedIds.push(id);
          }
          continue;
        }
        toApply.push(discovered);
        if (discovered.kind !== 'conflict') reloadedIds.push(id);
      }
      await this.applyDiscoveries(toApply);
      if (reloadedIds.length > 0 || removedIds.length > 0) {
        this.emitPluginsChanged(reloadedIds, removedIds);
      }
      return this.list();
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginDescriptor[]> {
    return await this.runSerialized(async () => {
      if (this.disposed) return this.list();
      if (this.builtinIds.has(id) || RESERVED_PLUGIN_IDS.has(id) || !PLUGIN_ID_RE.test(id)) {
        invalid(`Invalid external plugin id "${id}"`);
      }
      const existing = this.entries.get(id);
      if (!existing) {
        invalid(`Unknown external plugin "${id}"`, 'shell/plugin-not-found');
      }

      if (enabled) this.disabledIds.delete(id);
      else this.disabledIds.add(id);
      await this.writeDisabledState();

      if (!enabled) {
        this.unloadFromKernel(id);
        this.entries.set(id, {
          manifest: existing.manifest,
          enabled: false,
          status: 'disabled',
          loadedInKernel: false,
        });
        this.emitPluginsChanged([], [id]);
        return this.list();
      }

      const rootReal = await this.ensurePluginsRoot();
      this.unloadFromKernel(id);
      const discovered = await this.discoverEntry(id, rootReal);
      if (discovered.kind === 'ignore') {
        this.entries.delete(id);
        this.emitPluginsChanged([], [id]);
        return this.list();
      }
      await this.applyDiscoveries([discovered]);
      this.emitPluginsChanged([id], []);
      return this.list();
    });
  }

  startWatching(): void {
    if (this.watcher || this.disposed) return;
    const listener = (_eventType: string, filename: string | null) => {
      this.handleFsEvent(filename);
    };
    const watcher = this.watchDir(this.pluginsDir, listener);
    watcher.on?.('error', cause => {
      this.options.log.warn('External plugin watcher error', cause);
    });
    this.watcher = watcher;
  }

  private handleFsEvent(filename: string | null): void {
    if (this.disposed) return;
    if (typeof filename === 'string' && filename.length > 0) {
      const parts = filename.replaceAll('\\', '/').split('/').filter(Boolean);
      const top = parts[0];
      if (!top || this.builtinIds.has(top) || RESERVED_PLUGIN_IDS.has(top) || !PLUGIN_ID_RE.test(top)) {
        return;
      }
      if (parts.length === 1) {
        this.pendingIds.add(top);
      } else if (parts.length === 2 && WATCHED_PLUGIN_FILES.has(parts[1]!)) {
        this.pendingIds.add(top);
      } else {
        return;
      }
    } else {
      this.reloadAllPending = true;
    }

    this.debounceCancel?.();
    this.debounceCancel = this.options.clock.setTimeout(() => {
      this.debounceCancel = undefined;
      void this.flushWatchQueue().catch(cause => {
        this.options.log.error('Debounced external plugin reload failed', cause);
      });
    }, this.debounceMs);
  }

  private async flushWatchQueue(): Promise<void> {
    if (this.disposed) return;
    const reloadAll = this.reloadAllPending;
    const ids = [...this.pendingIds].sort((a, b) => a.localeCompare(b));
    this.reloadAllPending = false;
    this.pendingIds.clear();
    if (reloadAll) {
      await this.reload();
      return;
    }
    for (const id of ids) {
      await this.reload(id);
    }
  }

  async resolveProtocolRequest(request: ProtocolRequestLike): Promise<Response> {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    if (url.protocol !== `${PLUGIN_PROTOCOL}:`) {
      return new Response('Not Found', { status: 404 });
    }
    const id = url.hostname;
    if (!PLUGIN_ID_RE.test(id)) {
      return new Response('Forbidden', { status: 403 });
    }
    const entry = this.entries.get(id);
    if (!entry || !entry.enabled) {
      return new Response('Not Found', { status: 404 });
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    let safeRel: string;
    try {
      safeRel = normalizeRelPath(decodedPath);
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
    if (!isAllowedUiRelPath(safeRel)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const rootReal = await this.ensurePluginsRoot();
      const { fileReal, relPath } = await resolveContainedFile(rootReal, id, safeRel);
      const mime = PROTOCOL_MIME_TYPES[extname(relPath).toLowerCase()] ?? 'application/octet-stream';
      const body = method === 'HEAD' ? null : new Uint8Array(await readFile(fileReal));
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': mime,
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        },
      });
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause &&
        ['shell/path-outside-root', 'shell/invalid-plugin-id'].includes(String(cause.code))) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response('Not Found', { status: 404 });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.debounceCancel?.();
    this.debounceCancel = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    for (const dispose of this.disposers.splice(0)) dispose();
  }
}
