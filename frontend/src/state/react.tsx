import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { AppState, AppStore } from './store';

const StoreContext = createContext<AppStore | null>(null);

export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore: no StoreProvider above');
  return store;
}

export function useAppState(): AppState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** The store clock's time, refreshed every intervalMs. */
export function useNow(intervalMs = 1000): number {
  const { clock } = useStore();
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    setNow(clock.now());
    return clock.setInterval(() => setNow(clock.now()), intervalMs);
  }, [clock, intervalMs]);
  return now;
}
