import type { Json, QuestInput, UiContext } from '@featherlog/contracts';
import { createRoot } from 'react-dom/client';
import { Journal } from './Journal';
import { createNotesLink } from './notes-link';
import { createScribeLink } from './scribe-link';
import { createQuestStore } from './store';
import { TrackerNote } from './TrackerNote';

/** Renderer entry of the quest plugin (manifest `ui`). */
export function setup(ctx: UiContext): void {
  const store = createQuestStore(ctx.bus, ctx.sound);
  const scribe = createScribeLink(ctx.bus);
  const notes = createNotesLink(ctx.bus, ctx.sound);
  ctx.onDispose(() => store.dispose());
  ctx.onDispose(() => scribe.dispose());
  const openWithDraft = (input: QuestInput, note?: string) =>
    void ctx.bus
      .request('shell/open-panel', { tab: 'quest/journal', params: { draft: input as unknown as Json, ...(note ? { note } : {}) } })
      .catch((cause) => ctx.log.error('Could not open the journal with a draft', cause));

  ctx.slots.provide('panel.tab', 'quest/journal', (el, host) => {
    const root = createRoot(el);
    root.render(<Journal store={store} scribe={scribe} notes={notes} host={host} />);
    return () => root.unmount();
  });

  ctx.slots.provide('collapsed.preview', 'quest/tracker', (el, host) => {
    const root = createRoot(el);
    root.render(<TrackerNote store={store} host={host} scribe={scribe} onDraft={({ input, note }) => openWithDraft(input, note)} />);
    return () => root.unmount();
  });
}
