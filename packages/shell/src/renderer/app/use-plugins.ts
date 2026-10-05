import type { PluginEntry, PluginManifest } from '@featherlog/contracts';
import { useSyncExternalStore } from 'react';
import type { WindowRuntime } from './runtime';

/** The plugins running in this window, redrawn as optional ones are turned on or off. */
export function useManifests(runtime: WindowRuntime): PluginManifest[] {
  return useSyncExternalStore(runtime.onPluginsChange, () => runtime.manifests);
}

/** Every plugin the shell knows, with whether it is on. */
export function usePluginEntries(runtime: WindowRuntime): PluginEntry[] {
  return useSyncExternalStore(runtime.onPluginsChange, () => runtime.plugins);
}
