import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock, Dispose, Envelope, Json } from '@featherlog/contracts';
import { createKernel, type MainPlugin } from '@featherlog/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalPluginManager, isWithin, resolveContainedFile, type WatcherLike } from './external-plugins';
import { loadSettings } from './settings';
import { JsonFiles, pluginStorage } from './storage';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

class FakeClock implements Clock {
  private current = 1000;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, ms: number): Dispose {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + Math.max(0, ms), fn: callback });
    return () => {
      this.timers.delete(id);
    };
  }

  async advance(ms: number): Promise<void> {
    this.current += ms;
    while (true) {
      const due = [...this.entriesDue()].sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) break;
      const [id, item] = due[0]!;
      this.timers.delete(id);
      item.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  private *entriesDue() {
    for (const entry of this.timers.entries()) {
      if (entry[1].at <= this.current) yield entry;
    }
  }
}

async function setupHarness(options?: {
  savedSettings?: Json;
  savedExternalState?: Json;
  importModule?: (specifier: string) => Promise<Record<string, unknown>>;
  importTimeoutMs?: number;
}) {
  const root = await mkdtemp(join(tmpdir(), 'featherlog-ext-'));
  roots.push(root);
  const clock = new FakeClock();
  const files = new JsonFiles(clock);
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  if (options?.savedSettings !== undefined) {
    await writeFile(join(root, 'settings.json'), JSON.stringify(options.savedSettings));
  }
  if (options?.savedExternalState !== undefined) {
    await writeFile(
      join(root, 'external-plugins.json'),
      typeof options.savedExternalState === 'string'
        ? options.savedExternalState
        : JSON.stringify(options.savedExternalState),
    );
  }

  const builtin: MainPlugin = {
    manifest: { id: 'quest', name: 'Built-in Quest', version: '1.0.0' },
    setup() {},
  };
  const settings = loadSettings(root, [builtin.manifest], files, log, clock);
  const kernel = createKernel({
    clock,
    log,
    setupTimeoutMs: 500,
    createServices: id => ({
      clock,
      log,
      storage: pluginStorage(root, id, files),
      settings: settings.forPlugin(id),
      secrets: { get: async () => undefined, onChange: () => () => {} },
    }),
  });
  await kernel.load([builtin]);

  let watcherListener: ((eventType: string, filename: string | null) => void) | undefined;
  let watcherErrorListener: ((error: Error) => void) | undefined;
  const closeWatcher = vi.fn();
  const watchDir = (_dir: string, listener: (eventType: string, filename: string | null) => void): WatcherLike => {
    watcherListener = listener;
    return {
      close: closeWatcher,
      on(event, fn) {
        if (event === 'error') watcherErrorListener = fn;
      },
    };
  };

  const events: Envelope[] = [];
  const offObserve = kernel.observe(message => {
    events.push(message);
  });

  const shellBus = kernel.createBus('shell');
  const manager = new ExternalPluginManager({
    userData: root,
    builtinPlugins: [builtin],
    kernel,
    shellBus,
    settings,
    files,
    clock,
    log,
    debounceMs: 150,
    importTimeoutMs: options?.importTimeoutMs ?? 500,
    importModule: options?.importModule,
    watchDir,
  });

  return {
    root,
    pluginsDir: join(root, 'plugins'),
    clock,
    files,
    log,
    settings,
    kernel,
    shellBus,
    manager,
    events,
    offObserve,
    emitWatch: (eventType: string, filename: string | null) => watcherListener?.(eventType, filename),
    emitWatchError: (err: Error) => watcherErrorListener?.(err),
    closeWatcher,
  };
}

async function writeExternalPlugin(
  pluginsDir: string,
  id: string,
  manifest: Record<string, unknown>,
  mainCode: string,
  uiCode?: string,
) {
  const dir = join(pluginsDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, 'main.js'), mainCode);
  if (uiCode !== undefined) {
    await writeFile(join(dir, 'ui.js'), uiCode);
  }
  return dir;
}

describe('ExternalPluginManager', () => {
  it('loads valid external plugins, ignores storage-only folders, and registers preserved settings', async () => {
    const h = await setupHarness({
      savedSettings: {
        shell: {},
        plugins: {
          notebox: { folder: '/saved/folder', obsolete: 'drop' },
        },
      },
    });
    await mkdir(join(h.pluginsDir, 'quest'), { recursive: true });
    await writeFile(join(h.pluginsDir, 'quest', 'quests.json'), JSON.stringify({ items: [] }));
    await writeFile(join(h.pluginsDir, '.DS_Store'), 'junk');

    await writeExternalPlugin(
      h.pluginsDir,
      'notebox',
      {
        id: 'notebox',
        name: 'Notebox',
        version: '1.0.0',
        contributes: {
          settings: {
            schema: {
              type: 'object',
              properties: {
                folder: { type: 'string', default: '/default' },
                limit: { type: 'number', default: 5 },
              },
            },
          },
        },
      },
      `export function setup(ctx) {
        ctx.bus.handle('notebox/ping', () => ({
          folder: ctx.settings.get('folder'),
          limit: ctx.settings.get('limit'),
        }));
      }`,
      `export function setup() {}`,
    );

    await h.manager.loadAll();
    const descriptors = await h.shellBus.request('shell/plugins', {});
    expect(descriptors).toHaveLength(2);
    expect(descriptors[0]).toMatchObject({ source: 'builtin', status: 'loaded', manifest: { id: 'quest' } });
    expect(descriptors[1]).toMatchObject({
      source: 'external',
      enabled: true,
      status: 'loaded',
      manifest: { id: 'notebox', version: '1.0.0' },
    });
    expect(descriptors[1]!.uiUrl).toMatch(/^featherlog-plugin:\/\/notebox\/ui\.js\?v=1000-\d+$/);

    const pong = await h.shellBus.request('notebox/ping' as never, {} as never);
    expect(pong).toEqual({ folder: '/saved/folder', limit: 5 });

    h.manager.dispose();
    h.offObserve();
  });

  it('isolates invalid IDs, built-in conflicts, failing imports, import timeouts, and failing setup without blocking startup', async () => {
    let onHangStarted!: () => void;
    const hangStarted = new Promise<void>(resolve => {
      onHangStarted = resolve;
    });
    const h = await setupHarness({
      importTimeoutMs: 200,
      importModule: async specifier => {
        if (specifier.includes('/hang/')) {
          onHangStarted();
          return await new Promise(() => {});
        }
        return await import(specifier);
      },
    });

    await writeExternalPlugin(h.pluginsDir, 'quest', { id: 'quest', name: 'Conflict', version: '1.0.0' }, 'export function setup(){}');
    await writeExternalPlugin(h.pluginsDir, 'kernel', { id: 'kernel', name: 'Reserved', version: '1.0.0' }, 'export function setup(){}');
    await writeExternalPlugin(h.pluginsDir, 'mismatch', { id: 'other-id', name: 'Mismatch', version: '1.0.0' }, 'export function setup(){}');
    await writeExternalPlugin(h.pluginsDir, 'no-setup', { id: 'no-setup', name: 'NoSetup', version: '1.0.0' }, 'export const value = 1;');
    await writeExternalPlugin(h.pluginsDir, 'bad-setup', { id: 'bad-setup', name: 'BadSetup', version: '1.0.0' }, 'export function setup(){ throw new Error("boom"); }');
    await writeExternalPlugin(h.pluginsDir, 'hang', { id: 'hang', name: 'Hang', version: '1.0.0' }, 'export function setup(){}');
    await writeExternalPlugin(h.pluginsDir, 'good', { id: 'good', name: 'Good', version: '1.0.0' }, 'export function setup(ctx){ ctx.bus.handle("good/ok", () => ({ ok: true })); }');

    const loadPromise = h.manager.loadAll();
    await hangStarted;
    await Promise.resolve();
    await h.clock.advance(250);
    await loadPromise;

    const failedIds = h.events
      .filter(msg => msg.type === 'kernel/plugin-failed')
      .map(msg => (msg.payload as { pluginId: string }).pluginId);
    expect(failedIds).toEqual(expect.arrayContaining(['quest', 'kernel', 'mismatch', 'no-setup', 'bad-setup', 'hang']));

    expect(await h.shellBus.request('good/ok' as never, {} as never)).toEqual({ ok: true });
    const list = h.manager.list();
    expect(list.find(item => item.manifest.id === 'quest')?.source).toBe('builtin');
    expect(list.find(item => item.manifest.id === 'hang')?.status).toBe('failed');
    expect(list.find(item => item.manifest.id === 'bad-setup')?.error?.message).toBe('boom');
    expect(list.find(item => item.manifest.id === 'good')?.status).toBe('loaded');

    h.manager.dispose();
    h.offObserve();
  });

  it('enforces strict path containment, blocks escaping symlinks, storage json, and main.js over featherlog-plugin://', async () => {
    const h = await setupHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), 'featherlog-outside-'));
    roots.push(outsideDir);
    await writeFile(join(outsideDir, 'secret.js'), 'export default "secret";');
    await writeFile(join(outsideDir, 'manifest.json'), JSON.stringify({ id: 'escaped-dir', name: 'Evil', version: '1.0.0' }));

    const pluginDir = await writeExternalPlugin(
      h.pluginsDir,
      'safe',
      { id: 'safe', name: 'Safe', version: '1.0.0', ui: './ui.js' },
      'export function setup() {}',
      'export function setup() {}',
    );
    await writeFile(join(pluginDir, 'state.json'), JSON.stringify({ privateNote: 'secret' }));
    await writeFile(join(pluginDir, 'chunk.css'), '.box { color: red; }');
    await symlink(join(outsideDir, 'secret.js'), join(pluginDir, 'leak.js'));
    await symlink(outsideDir, join(h.pluginsDir, 'escaped-dir'));

    await h.manager.loadAll();

    const realRoot = join(h.pluginsDir);
    expect(isWithin('/tmp/plugins', '/tmp/plugins')).toBe(false);
    expect(isWithin('/tmp/plugins', '/tmp/plugins-other/a.js')).toBe(false);
    await expect(resolveContainedFile(realRoot, 'safe', '../quest/quests.json'))
      .rejects.toMatchObject({ code: 'shell/path-outside-root' });
    await expect(resolveContainedFile(realRoot, 'safe', 'leak.js'))
      .rejects.toMatchObject({ code: 'shell/path-outside-root' });
    await expect(resolveContainedFile(realRoot, 'escaped-dir', 'secret.js'))
      .rejects.toMatchObject({ code: 'shell/path-outside-root' });

    const req = (url: string, method = 'GET') => h.manager.resolveProtocolRequest({ url, method });
    expect((await req('featherlog-plugin://safe/ui.js', 'POST')).status).toBe(405);
    expect((await req('not a url')).status).toBe(400);
    expect((await req('featherlog-plugin://safe/%ZZ')).status).toBe(400);
    expect((await req('featherlog-plugin://Bad_Id/ui.js')).status).toBe(403);
    expect((await req('featherlog-plugin://unknown/ui.js')).status).toBe(404);
    expect((await req('featherlog-plugin://safe/..%2fquest/quests.json')).status).toBe(403);
    expect((await req('featherlog-plugin://safe/leak.js')).status).toBe(403);
    expect((await req('featherlog-plugin://safe/state.json')).status).toBe(403);
    expect((await req('featherlog-plugin://safe/manifest.json')).status).toBe(403);
    expect((await req('featherlog-plugin://safe/main.js')).status).toBe(403);
    expect((await req('featherlog-plugin://safe/missing.js')).status).toBe(404);

    const okUi = await req('featherlog-plugin://safe/ui.js?v=123');
    expect(okUi.status).toBe(200);
    expect(okUi.headers.get('content-type')).toContain('text/javascript');
    expect(await okUi.text()).toContain('export function setup()');

    const okCssHead = await req('featherlog-plugin://safe/chunk.css', 'HEAD');
    expect(okCssHead.status).toBe(200);
    expect(okCssHead.headers.get('content-type')).toContain('text/css');
    expect(await okCssHead.text()).toBe('');

    h.manager.dispose();
    h.offObserve();
  });

  it('hot-reloads updated plugins via debounced fs.watch while ignoring storage writes and cleaning old timers', async () => {
    const h = await setupHarness();
    const hotDir = await writeExternalPlugin(
      h.pluginsDir,
      'hot',
      {
        id: 'hot',
        name: 'Hot',
        version: '1.0.0',
        contributes: { settings: { schema: { type: 'object', properties: { tag: { type: 'string', default: 'v1' } } } } },
      },
      `export function setup(ctx) {
        ctx.clock.setTimeout(() => { ctx.bus.emit('hot/tick', { ver: 1 }); }, 500);
        ctx.bus.handle('hot/ver', () => ({ ver: 1, tag: ctx.settings.get('tag') }));
      }`,
      'export function setup() { /* v1 */ }',
    );
    await h.manager.loadAll();
    await h.settings.set('hot', 'tag', 'user-custom');
    h.manager.startWatching();
    h.emitWatchError(new Error('transient watch warning'));
    expect(h.log.warn).toHaveBeenCalled();

    const firstUiUrl = h.manager.list().find(p => p.manifest.id === 'hot')?.uiUrl;
    expect(await h.shellBus.request('hot/ver' as never, {} as never)).toEqual({ ver: 1, tag: 'user-custom' });

    // Storage file writes inside external or built-in folders must NOT trigger reload.
    h.emitWatch('change', 'hot/state.json');
    h.emitWatch('rename', 'hot/state.json.tmp.123');
    h.emitWatch('change', 'quest/quests.json');
    await h.clock.advance(200);
    expect(h.events.some(e => e.type === 'shell/plugins-changed')).toBe(false);

    // Update v2 files on disk and trigger debounced watched events (must coalesce to one reload).
    await writeExternalPlugin(
      h.pluginsDir,
      'hot',
      {
        id: 'hot',
        name: 'Hot',
        version: '2.0.0',
        contributes: {
          settings: {
            schema: {
              type: 'object',
              properties: {
                tag: { type: 'string', default: 'v2' },
                extra: { type: 'number', default: 42 },
              },
            },
          },
        },
      },
      `export function setup(ctx) {
        ctx.bus.handle('hot/ver', () => ({ ver: 2, tag: ctx.settings.get('tag'), extra: ctx.settings.get('extra') }));
      }`,
      'export function setup() { /* v2 */ }',
    );

    h.emitWatch('change', 'hot/main.js');
    await h.clock.advance(50);
    h.emitWatch('change', 'hot/ui.js');
    await h.clock.advance(160);
    // Wait for async reload task in queue, then advance past v1's original 500ms timer.
    await vi.waitFor(() => {
      expect(h.events.filter(e => e.type === 'shell/plugins-changed')).toHaveLength(1);
    });
    await h.clock.advance(400);

    // Old v1 100ms timer was cancelled on kernel.unload('hot') so hot/tick never fires.
    expect(h.events.some(e => e.type === 'hot/tick')).toBe(false);
    const reloadedEvents = h.events.filter(e => e.type === 'shell/plugins-changed');
    expect(reloadedEvents).toHaveLength(1);
    expect((reloadedEvents[0]!.payload as { reloadedIds?: string[] }).reloadedIds).toEqual(['hot']);

    const secondUiUrl = h.manager.list().find(p => p.manifest.id === 'hot')?.uiUrl;
    expect(secondUiUrl).not.toBe(firstUiUrl);
    expect(await h.shellBus.request('hot/ver' as never, {} as never)).toEqual({
      ver: 2,
      tag: 'user-custom',
      extra: 42,
    });

    // Removing the plugin directory removes it cleanly on reload.
    await rm(hotDir, { recursive: true, force: true });
    await h.shellBus.request('shell/reload-plugins', {});
    expect(h.manager.list().some(p => p.manifest.id === 'hot')).toBe(false);
    const removedEvent = h.events.filter(e => e.type === 'shell/plugins-changed').at(-1);
    expect((removedEvent?.payload as { removedIds?: string[] }).removedIds).toEqual(['hot']);

    h.manager.dispose();
    expect(h.closeWatcher).toHaveBeenCalledOnce();
    h.offObserve();
  });

  it('toggles external plugins enabled/disabled while persisting state and preserving settings', async () => {
    const h = await setupHarness();
    await writeExternalPlugin(
      h.pluginsDir,
      'tog',
      {
        id: 'tog',
        name: 'Toggleable',
        version: '1.0.0',
        contributes: { settings: { schema: { type: 'object', properties: { mode: { type: 'string', default: 'a' } } } } },
      },
      'export function setup(ctx) { ctx.bus.handle("tog/ping", () => ({ mode: ctx.settings.get("mode") })); }',
      'export function setup() {}',
    );
    await h.manager.loadAll();
    await h.settings.set('tog', 'mode', 'custom');

    const disabledList = await h.shellBus.request('shell/set-plugin-enabled', { id: 'tog', enabled: false });
    expect(disabledList.find(p => p.manifest.id === 'tog')).toMatchObject({
      enabled: false,
      status: 'disabled',
    });
    expect(disabledList.find(p => p.manifest.id === 'tog')?.uiUrl).toBeUndefined();
    expect((await h.manager.resolveProtocolRequest({ url: 'featherlog-plugin://tog/ui.js' })).status).toBe(404);
    await expect(h.shellBus.request('tog/ping' as never, {} as never)).rejects.toMatchObject({ code: 'no-handler' });

    await h.files.flush();
    const stateOnDisk = JSON.parse(await readFile(join(h.root, 'external-plugins.json'), 'utf8')) as { disabled: string[] };
    expect(stateOnDisk.disabled).toEqual(['tog']);

    const enabledList = await h.shellBus.request('shell/set-plugin-enabled', { id: 'tog', enabled: true });
    expect(enabledList.find(p => p.manifest.id === 'tog')).toMatchObject({
      enabled: true,
      status: 'loaded',
    });
    expect(await h.shellBus.request('tog/ping' as never, {} as never)).toEqual({ mode: 'custom' });

    await expect(h.shellBus.request('shell/set-plugin-enabled', { id: 'quest', enabled: false }))
      .rejects.toMatchObject({ code: 'shell/invalid-input' });
    await expect(h.shellBus.request('shell/set-plugin-enabled', { id: 'missing', enabled: false }))
      .rejects.toMatchObject({ code: 'shell/plugin-not-found' });

    h.manager.dispose();
    h.offObserve();
  });
});
