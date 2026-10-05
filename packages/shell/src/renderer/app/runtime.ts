import type {
  Dispose,
  FeatherlogPreload,
  Json,
  PluginEntry,
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
  /** Plugins whose UI half runs in this window: built-in ones and enabled optional ones (design §17.1). */
  readonly manifests: PluginManifest[];
  /** Every plugin the shell knows, as it last reported them; empty for a shell that predates §17. */
  readonly plugins: PluginEntry[];
  /** Notified when plugins are turned on or off. */
  onPluginsChange(listener: () => void): Dispose;
  /** This window's sound player, shared by the shell and every plugin. */
  readonly sound: UiSound;
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

  // One plugin's UI half: set up now, torn down when it is turned off or the window goes.
  const start = async (plugin: UiPlugin): Promise<Dispose> => {
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
    try {
      await plugin.setup(ctx);
    } catch (cause) {
      // One plugin's UI failing must not take the window down with it.
      console.error(`[${id}] UI setup failed`, cause);
    }
    return () => own.reverse().forEach(run);
  };

  // Optional plugins run only while the shell has them loaded (design §17.1).
  let entries: PluginEntry[] = [];
  const running = new Map<string, Dispose>();
  const pluginListeners = new Set<() => void>();
  const wanted = (manifest: PluginManifest) =>
    !manifest.optional || entries.some((e) => e.id === manifest.id && e.enabled && e.state === 'loaded');
  // Replaced, never mutated, so React can compare snapshots.
  let active: PluginManifest[] = [];
  let syncing = Promise.resolve();
  const sync = () =>
    (syncing = syncing.then(async () => {
      for (const plugin of plugins) {
        const id = plugin.manifest.id;
        const stop = running.get(id);
        if (stop && !wanted(plugin.manifest)) {
          running.delete(id);
          run(stop);
        } else if (!stop && wanted(plugin.manifest)) {
          running.set(id, await start(plugin));
        }
      }
      active = plugins.filter((p) => running.has(p.manifest.id)).map((p) => p.manifest);
      pluginListeners.forEach((listener) => listener());
    }));
  try {
    entries = (await shellBus.request('shell/plugins', {})).plugins;
  } catch {
    // A shell without optional plugins: every built-in plugin runs, no optional one does.
  }
  disposers.push(
    shellBus.on('shell/plugins-changed', ({ plugins: next }) => {
      entries = next;
      void sync();
    }),
  );
  await sync();
  disposers.push(() => {
    for (const stop of [...running.values()].reverse()) run(stop);
    running.clear();
  });

  return {
    preload,
    registry,
    shellBus,
    get manifests() {
      return active;
    },
    get plugins() {
      return entries;
    },
    onPluginsChange(listener) {
      pluginListeners.add(listener);
      return () => pluginListeners.delete(listener);
    },
    sound,
    setting: <T extends Json>(scope: string, key: string) => settings[scope]?.[key] as T | undefined,
    onSettingChange,
    dispose: () => disposers.reverse().forEach(run),
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
