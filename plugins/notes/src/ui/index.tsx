import type { UiContext } from '@featherlog/contracts';
import { createRoot } from 'react-dom/client';
import { EssayBook } from './EssayBook';
import { QuickNote } from './QuickNote';
import { createNotesStore } from './store';

/** Renderer entry of the notes plugin (manifest `ui`): the 随笔 tab and the scroll's quick note. */
export function setup(ctx: UiContext): void {
  const store = createNotesStore(ctx.bus, ctx.sound);
  ctx.onDispose(() => store.dispose());

  ctx.slots.provide('panel.tab', 'notes/essays', (el) => {
    const root = createRoot(el);
    root.render(<EssayBook store={store} />);
    return () => root.unmount();
  });

  ctx.slots.provide('collapsed.preview', 'notes/quick', (el, host) => {
    const root = createRoot(el);
    root.render(<QuickNote store={store} host={host} />);
    return () => root.unmount();
  });
}
