import type { Json, PluginStorage } from '@featherlog/contracts';
import { keysUnder, load, save } from './persist';

/** ctx.storage for one plugin, kept in localStorage (design §5.5 semantics). */
export function createStorage(pluginId: string): PluginStorage {
  const prefix = `storage.${pluginId}.`;
  return {
    async get<T extends Json>(key: string) {
      const raw = load(prefix + key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    },
    async set(key, value) {
      save(prefix + key, JSON.stringify(value));
    },
    async delete(key) {
      save(prefix + key, null);
    },
    async keys() {
      return keysUnder(prefix).map((k) => k.slice(prefix.length));
    },
  };
}
