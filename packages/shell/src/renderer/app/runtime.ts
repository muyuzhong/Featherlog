import type {
  Dispose,
  FeatherlogPreload,
  Json,
  PluginDescriptor,
  PluginManifest,
  PluginSettings,
  UiBus,
  UiContext,
  UiSound,
} from '@featherlog/contracts';
import { createUiBus } from '../bus/ui-bus';
import { createSlotRegistry, type SlotRegistry } from '../slots/registry';
import { createSound } from '../sound/synth';

/** A plugin's renderer half, as listed by the composition root (design §6.1). */
export type UiPlugin = { manifest: PluginManifest; setup(ctx: UiContext): void | Promise<void> };

type Settings = Record<string, Record<string, Json>>;

export interface WindowRuntime {
  readonly preload: FeatherlogPreload;
  readonly registry: SlotRegistry;
  /** The shell's own bus, sending as "shell". */
  readonly shellBus: UiBus;
  readonly plugins: readonly PluginDescriptor[];
  readonly manifests: PluginManifest[];
  /** This window's sound player, shared by the shell and every plugin. */
  readonly sound: UiSound;
  subscribePlugins(listener: () => void): Dispose;
  reloadExternalPlugins(id?: string): Promise<void>;
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;
  setting<T extends Json>(scope: string, key: string): T | undefined;
  onSettingChange(listener: (scope: string, key: string, value: Json) => void): Dispose;
  dispose(): void;
}

/**
 * Everything one window needs before it renders: a bus per plugin over the
 * preload transport, a slot registry, settings, and every plugin UI set up.
 * Each window gets its own runtime, just as each window has its own renderer.
 */
export async function createRuntime(preload: FeatherlogPreload, plugins: UiPlugin[]): Promise<WindowRuntime> {
  const registry = createSlotRegistry();
  const disposers: Dispose[] = [];
  const settings: Settings = await preload.settings.all();
  const settingListeners = new Set<(scope: string, key: string, value: Json) => void>();
  disposers.push(
    preload.settings.onChange((scope, key, value) => {
      (settings[scope] ??= {})[key] = value;
      settingListeners.forEach((listener) => listener(scope, key, value));
    }),
  );
  const onSettingChange = (listener: (scope: string, key: string, value: Json) => void): Dispose => {
    settingListeners.add(listener);
    return () => settingListeners.delete(listener);
  };

  // Defaults match the shell settings schema (design §6.6) for shells that predate them.
  const sound = createSound({
    enabled: () => settings.shell?.sound !== false,
    volume: () => (typeof settings.shell?.volume === 'number' ? settings.shell.volume : 6),
  });
  disposers.push(sound.dispose);

  const shellBus = createUiBus(preload.bus, 'shell');
  disposers.push(shellBus.dispose);

  const pluginListeners = new Set<() => void>();
  const subscribePlugins = (listener: () => void): Dispose => {
    pluginListeners.add(listener);
    return () => pluginListeners.delete(listener);
  };
  let pluginsSnapshot: readonly PluginDescriptor[] = plugins.map((p) => ({
    manifest: p.manifest,
    source: 'builtin' as const,
    enabled: true,
    status: 'loaded' as const,
  }));
  let disposed = false;

  const mountUiPlugin = async (plugin: UiPlugin): Promise<Dispose> => {
    const id = plugin.manifest.id;
    const bus = createUiBus(preload.bus, id);
    const slots = registry.providerFor(id);
    const pluginSettings: PluginSettings = {
      get: <T extends Json>(key: string) => settings[id]?.[key] as T | undefined,
      onChange: (listener) => onSettingChange((scope, key, value) => scope === id && listener(key, value)),
    };
    const own: Dispose[] = [bus.dispose, slots.dispose];
    const ctx: UiContext = {
      pluginId: id,
      bus,
      slots,
      settings: pluginSettings,
      sound,
      log: prefixed(id),
      onDispose: (callback) => void own.push(callback),
    };
    const cleanup = () => own.splice(0).reverse().forEach(run);
    try {
      await plugin.setup(ctx);
    } catch (cause) {
      cleanup();
      // One plugin's UI failing must not take the window down with it.
      console.error(`[${id}] UI setup failed`, cause);
    }
    return cleanup;
  };

  for (const plugin of plugins) {
    const cleanup = await mountUiPlugin(plugin);
    disposers.push(cleanup);
  }

  const mountedExternals = new Map<string, { uiUrl?: string; dispose: Dispose }>();
  const refreshSettings = async () => {
    const fresh = await preload.settings.all();
    for (const scope of Object.keys(settings)) {
      if (!Object.hasOwn(fresh, scope)) delete settings[scope];
    }
    for (const [scope, nextValues] of Object.entries(fresh)) {
      const prevValues = settings[scope];
      settings[scope] = nextValues;
      for (const [key, value] of Object.entries(nextValues)) {
        if (!prevValues || JSON.stringify(prevValues[key]) !== JSON.stringify(value)) {
          settingListeners.forEach((listener) => listener(scope, key, value));
        }
      }
    }
  };

  let syncQueue: Promise<void> = Promise.resolve();
  const syncExternalPlugins = async (
    nextDescriptors: PluginDescriptor[],
    reloadedIds?: string[],
    removedIds?: string[],
  ) => {
    if (disposed) return;
    const byId = new Map(nextDescriptors.map((item) => [item.manifest.id, item]));
    const reloaded = new Set(reloadedIds ?? []);
    const removed = new Set(removedIds ?? []);

    for (const [id, mounted] of [...mountedExternals.entries()]) {
      const next = byId.get(id);
      const shouldUnmount = !next
        || next.source !== 'external'
        || !next.enabled
        || next.status !== 'loaded'
        || !next.uiUrl
        || removed.has(id)
        || reloaded.has(id)
        || mounted.uiUrl !== next.uiUrl;
      if (shouldUnmount) {
        mountedExternals.delete(id);
        run(mounted.dispose);
      }
    }

    await refreshSettings();
    if (disposed) return;

    for (const item of nextDescriptors) {
      if (item.source !== 'external' || !item.enabled || item.status !== 'loaded' || !item.uiUrl) continue;
      if (mountedExternals.has(item.manifest.id)) continue;
      try {
        const mod = (await import(/* @vite-ignore */ item.uiUrl)) as { setup?: UiPlugin['setup'] };
        if (disposed) return;
        if (typeof mod.setup === 'function') {
          const dispose = await mountUiPlugin({ manifest: item.manifest, setup: mod.setup });
          if (disposed) {
            run(dispose);
            return;
          }
          mountedExternals.set(item.manifest.id, { uiUrl: item.uiUrl, dispose });
        }
      } catch (cause) {
        console.error(`[${item.manifest.id}] External UI load failed`, cause);
      }
    }

    pluginsSnapshot = Object.freeze([...nextDescriptors]);
    pluginListeners.forEach((listener) => listener());
  };

  const enqueueSync = (
    nextDescriptors: PluginDescriptor[],
    reloadedIds?: string[],
    removedIds?: string[],
  ): Promise<void> => {
    const task = syncQueue.then(() => syncExternalPlugins(nextDescriptors, reloadedIds, removedIds));
    syncQueue = task.catch((cause) => console.error('Plugin sync failed', cause));
    return task;
  };

  disposers.push(
    shellBus.on('shell/plugins-changed', ({ plugins: next, reloadedIds, removedIds }) => {
      void enqueueSync(next, reloadedIds, removedIds);
    }),
  );

  try {
    const initial = await shellBus.request('shell/plugins', {});
    await enqueueSync(initial);
  } catch {
    // Non-shell hosts (such as playground) do not implement external plugin handlers.
  }

  return {
    preload,
    registry,
    shellBus,
    get plugins() {
      return pluginsSnapshot;
    },
    get manifests() {
      return pluginsSnapshot.filter((item) => item.enabled && item.status === 'loaded').map((item) => item.manifest);
    },
    subscribePlugins,
    reloadExternalPlugins: async (id?: string) => {
      const next = await shellBus.request('shell/reload-plugins', id ? { id } : {});
      await enqueueSync(next, id ? [id] : undefined);
    },
    setPluginEnabled: async (id: string, enabled: boolean) => {
      const next = await shellBus.request('shell/set-plugin-enabled', { id, enabled });
      await enqueueSync(next, enabled ? [id] : undefined, enabled ? undefined : [id]);
    },
    sound,
    setting: <T extends Json>(scope: string, key: string) => settings[scope]?.[key] as T | undefined,
    onSettingChange,
    dispose: () => {
      disposed = true;
      for (const mounted of mountedExternals.values()) run(mounted.dispose);
      mountedExternals.clear();
      disposers.reverse().forEach(run);
    },
  };
}

function run(dispose: Dispose) {
  try {
    dispose();
  } catch (cause) {
    console.error(cause);
  }
}

function prefixed(id: string) {
  const tag = `[${id}]`;
  return {
    debug: (message: string, data?: unknown) => console.debug(tag, message, data ?? ''),
    info: (message: string, data?: unknown) => console.info(tag, message, data ?? ''),
    warn: (message: string, data?: unknown) => console.warn(tag, message, data ?? ''),
    error: (message: string, data?: unknown) => console.error(tag, message, data ?? ''),
  };
}
