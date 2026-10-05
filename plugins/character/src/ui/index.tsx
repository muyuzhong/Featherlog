import type { UiContext } from '@featherlog/contracts';
import { createRoot } from 'react-dom/client';
import { CharacterBook } from './CharacterBook';
import { createCharacterStore } from './store';

/** Renderer entry of the character plugin (manifest `ui`): the 角色 tab. */
export function setup(ctx: UiContext): void {
  const store = createCharacterStore(ctx.bus, ctx.sound);
  ctx.onDispose(() => store.dispose());

  ctx.slots.provide('panel.tab', 'character/sheet', (el, host) => {
    const root = createRoot(el);
    root.render(<CharacterBook store={store} host={host} />);
    return () => root.unmount();
  });
}
