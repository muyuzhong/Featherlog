import type { UiContext } from '@featherlog/contracts';
import { createRoot } from 'react-dom/client';
import { Journal } from './Journal';
import { createQuestStore } from './store';
import { TrackerNote } from './TrackerNote';

/** Renderer entry of the quest plugin (manifest `ui`). */
export function setup(ctx: UiContext): void {
  const store = createQuestStore(ctx.bus, ctx.sound);
  ctx.onDispose(() => store.dispose());

  ctx.slots.provide('panel.tab', 'quest/journal', (el) => {
    const root = createRoot(el);
    root.render(<Journal store={store} />);
    return () => root.unmount();
  });

  ctx.slots.provide('collapsed.preview', 'quest/tracker', (el, host) => {
    const root = createRoot(el);
    root.render(<TrackerNote store={store} host={host} />);
    return () => root.unmount();
  });
}
