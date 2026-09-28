import type { Dispose, Json, PluginManifest, PluginSettings } from '@featherlog/contracts';
import { load, save } from './persist';

type Values = Record<string, Record<string, Json>>;
type Listener = (scope: string, key: string, value: Json) => void;

/** The shell's own settings and their defaults (design §6.6). */
export const SHELL_DEFAULTS: Record<string, Json> = {
  edge: 'right',
  display: 'auto',
  verticalPosition: 0.5,
  paper: 'vellum',
  compatMode: false,
};

/** Settings for the shell and every plugin: schema defaults, overridden by saved values. */
export function createSettings(manifests: PluginManifest[]) {
  const saved = JSON.parse(load('settings') ?? '{}') as Values;
  const values: Values = { shell: { ...SHELL_DEFAULTS, ...saved.shell } };
  for (const manifest of manifests) {
    const schema = manifest.contributes?.settings?.schema as { properties?: Record<string, { default?: Json }> } | undefined;
    const defaults = Object.fromEntries(
      Object.entries(schema?.properties ?? {}).flatMap(([key, prop]) => (prop.default === undefined ? [] : [[key, prop.default]])),
    );
    values[manifest.id] = { ...defaults, ...saved[manifest.id] };
  }
  const listeners = new Set<Listener>();

  return {
    all: (): Values => structuredClone(values),
    set(scope: string, key: string, value: Json) {
      (values[scope] ??= {})[key] = value;
      const persisted = JSON.parse(load('settings') ?? '{}') as Values;
      (persisted[scope] ??= {})[key] = value;
      save('settings', JSON.stringify(persisted));
      listeners.forEach((listener) => listener(scope, key, value));
    },
    onChange(listener: Listener): Dispose {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** ctx.settings for a plugin's main half. */
    forPlugin(pluginId: string): PluginSettings {
      return {
        get: <T extends Json>(key: string) => values[pluginId]?.[key] as T | undefined,
        onChange: (listener) => {
          const wrapped: Listener = (scope, key, value) => scope === pluginId && listener(key, value);
          listeners.add(wrapped);
          return () => listeners.delete(wrapped);
        },
      };
    },
  };
}

export type SettingsHost = ReturnType<typeof createSettings>;
