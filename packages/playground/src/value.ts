import { useSyncExternalStore } from 'react';

/** A tiny observable value for the playground's host state. */
export function createValue<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type Value<T> = ReturnType<typeof createValue<T>>;

export function useValue<T>(value: Value<T>): T {
  return useSyncExternalStore(value.subscribe, value.get);
}
