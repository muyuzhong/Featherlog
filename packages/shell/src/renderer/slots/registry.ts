import type { Dispose, Mount, SlotKind, SlotProvider } from '@featherlog/contracts';

type Key = `${SlotKind}:${string}`;
type Entry = { pluginId: string; mount: Mount<SlotKind> };

export interface SlotRegistry {
  /** The SlotProvider handed to one plugin's UiContext. Disposing it removes everything it provided. */
  providerFor(pluginId: string): SlotProvider & { dispose: Dispose };
  get<K extends SlotKind>(kind: K, id: string): Mount<K> | undefined;
  /** Notified whenever a mount is provided or removed. */
  subscribe(listener: () => void): Dispose;
}

export function createSlotRegistry(): SlotRegistry {
  const entries = new Map<Key, Entry>();
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());

  return {
    providerFor(pluginId) {
      const owned = new Set<Key>();
      const remove = (key: Key) => {
        if (entries.get(key)?.pluginId !== pluginId) return;
        entries.delete(key);
        owned.delete(key);
        changed();
      };
      return {
        provide(kind, id, mount) {
          if (!id.startsWith(`${pluginId}/`)) throw new Error(`Plugin ${pluginId} cannot provide slot ${id}`);
          const key: Key = `${kind}:${id}`;
          if (entries.has(key)) throw new Error(`Slot ${key} is already provided`);
          entries.set(key, { pluginId, mount: mount as Mount<SlotKind> });
          owned.add(key);
          changed();
          return () => remove(key);
        },
        dispose() {
          for (const key of [...owned]) remove(key);
        },
      };
    },
    get(kind, id) {
      return entries.get(`${kind}:${id}`)?.mount as Mount<typeof kind> | undefined;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
