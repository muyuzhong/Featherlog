import type { UiContext } from '@featherlog/contracts';
import { createRoot } from 'react-dom/client';
import { DeckBook } from './DeckBook';
import { ReviewCard } from './ReviewCard';
import { createFlashcardsStore } from './store';

/**
 * Renderer entry of the 八股 example plugin (manifest `ui`). It runs once in each
 * window, only while the plugin is turned on (design §17.1), and provides the
 * slots its manifest declares: the card on the scroll and the 八股 tab.
 */
export function setup(ctx: UiContext): void {
  const store = createFlashcardsStore(ctx.bus, ctx.sound);
  // Everything registered through ctx is released when the plugin is turned off;
  // the store's own listeners are released here.
  ctx.onDispose(() => store.dispose());

  ctx.slots.provide('collapsed.preview', 'flashcards/card', (el, host) => {
    const root = createRoot(el);
    root.render(<ReviewCard store={store} host={host} />);
    return () => root.unmount();
  });

  ctx.slots.provide('panel.tab', 'flashcards/deck', (el) => {
    const root = createRoot(el);
    root.render(<DeckBook store={store} />);
    return () => root.unmount();
  });
}
