import type { UiContext } from '@featherlog/contracts';
import { createRoot } from 'react-dom/client';
import { ScribeBook } from './ScribeBook';

/** Renderer entry of the scribe plugin (manifest `ui`): the 札记 tab. */
export function setup(ctx: UiContext): void {
  ctx.slots.provide('panel.tab', 'scribe/notes', (el) => {
    const root = createRoot(el);
    root.render(<ScribeBook bus={ctx.bus} sound={ctx.sound} />);
    return () => root.unmount();
  });
}
