import { act, render } from '@testing-library/react';
import { App } from '../App';
import { ManualClock } from '../lib/clock';
import { LocalMockBridge } from '../rpc/mock';
import { StoreProvider } from '../state/react';
import { AppStore } from '../state/store';
import type { AppMode } from '../lib/mode';
import type { Cue } from '../lib/sound';

/** Wednesday 25 November 2026, 10:00 local time. */
export const T0 = new Date(2026, 10, 25, 10, 0, 0).getTime();
export const MIN = 60_000;

export interface SetupOptions {
  seed?: boolean;
  start?: number;
  mode?: AppMode;
  collapseOnBlur?: boolean;
}

export function setup(options: SetupOptions = {}) {
  const clock = new ManualClock(options.start ?? T0);
  const bridge = new LocalMockBridge({ clock, storage: null, seed: options.seed });
  const cues: Cue[] = [];
  const store = new AppStore({
    bridge,
    clock,
    prefs: null,
    sound: (cue) => cues.push(cue),
    mode: options.mode,
    collapseOnBlur: options.collapseOnBlur,
  });
  return { clock, bridge, store, cues };
}

/** Lets queued microtasks (mock events, settled calls) run. */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

export async function renderApp(options: SetupOptions & { expanded?: boolean } = {}) {
  const ctx = setup(options);
  await ctx.store.init();
  if (options.expanded) ctx.store.setExpanded(true);
  const utils = render(
    <StoreProvider store={ctx.store}>
      <App />
    </StoreProvider>,
  );
  await flush();
  return { ...ctx, ...utils };
}
