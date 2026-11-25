import { messages } from '../lib/i18n';
import { todoView } from '../lib/tasks';
import type { Language, ThemeMode } from '../rpc/types';
import type { AppState, AppStore } from '../state/store';

export type PaletteAction =
  | { type: 'focus-slot'; id: string }
  | { type: 'show-task'; id: string }
  | { type: 'search-notes'; query: string }
  | { type: 'new-slot' }
  | { type: 'compose' }
  | { type: 'theme'; theme: ThemeMode }
  | { type: 'language'; language: Language }
  | { type: 'pin' }
  | { type: 'sound' }
  | { type: 'collapse' }
  | { type: 'reset-bar-position' }
  | { type: 'quit' };

export type PaletteGroup = 'slot' | 'task' | 'command';

export interface PaletteItem {
  key: string;
  group: PaletteGroup;
  label: string;
  hint?: string;
  /** more words that find the item, in either language */
  keywords?: readonly string[];
  action: PaletteAction;
}

const LIMIT = 10;

/** The language command answers to its name in both languages, whichever one is showing. */
const LANGUAGE_KEYWORDS = ['语言', '中文', '英文', 'language', 'english', 'chinese'] as const;

function matches(query: string, ...texts: Array<string | undefined>): boolean {
  if (!query) return true;
  return texts.some((t) => t?.toLowerCase().includes(query));
}

/** What Ctrl+K offers for a query: slots, the todos the panel shows, then commands, worded in the UI's language. */
export function paletteItems(state: AppState, raw: string): PaletteItem[] {
  const t = messages(state.settings.language);
  const query = raw.trim().toLowerCase();
  const items: PaletteItem[] = [];
  state.slots.forEach((slot, i) => {
    if (matches(query, slot.title, slot.tag, slot.breadcrumb)) {
      items.push({
        key: `slot:${slot.id}`,
        group: 'slot',
        label: slot.title,
        hint: `Alt+${i + 1}`,
        action: { type: 'focus-slot', id: slot.id },
      });
    }
  });
  if (query) {
    const { open, done } = todoView(state.tasks);
    for (const task of [...open, ...done]) {
      if (!matches(query, task.title)) continue;
      items.push({
        key: `task:${task.id}`,
        group: 'task',
        label: task.title,
        hint: task.status === 'completed' ? t.palette.done : undefined,
        action: { type: 'show-task', id: task.id },
      });
    }
  }
  const { pinned, sound, theme, language, barX, barY } = state.settings;
  // Only a bar that was dragged somewhere has a place to forget.
  const resetBar: PaletteItem[] =
    barX != null || barY != null
      ? [{ key: 'cmd:reset-bar', group: 'command', label: t.settings.resetBar, action: { type: 'reset-bar-position' } }]
      : [];
  const commands: PaletteItem[] = [
    { key: 'cmd:new-slot', group: 'command', label: t.palette.newSlot, hint: 'Alt+N', action: { type: 'new-slot' } },
    { key: 'cmd:compose', group: 'command', label: t.palette.compose, action: { type: 'compose' } },
    {
      key: 'cmd:theme',
      group: 'command',
      label: theme === 'stone' ? t.palette.toGraphite : t.palette.toStone,
      action: { type: 'theme', theme: theme === 'stone' ? 'graphite' : 'stone' },
    },
    {
      key: 'cmd:language',
      group: 'command',
      label: t.palette.language,
      keywords: LANGUAGE_KEYWORDS,
      action: { type: 'language', language: language === 'zh' ? 'en' : 'zh' },
    },
    { key: 'cmd:pin', group: 'command', label: pinned ? t.palette.unpin : t.palette.pin, hint: 'Ctrl+P', action: { type: 'pin' } },
    { key: 'cmd:sound', group: 'command', label: sound ? t.palette.soundOff : t.palette.soundOn, action: { type: 'sound' } },
    { key: 'cmd:collapse', group: 'command', label: t.palette.collapse, hint: 'Esc', action: { type: 'collapse' } },
    ...resetBar,
    { key: 'cmd:quit', group: 'command', label: t.palette.quit, action: { type: 'quit' } },
  ];
  const found = commands.filter((c) => matches(query, c.label, ...(c.keywords ?? [])));
  if (query) {
    found.unshift({
      key: 'cmd:search-notes',
      group: 'command',
      label: t.palette.searchNotes(raw.trim()),
      action: { type: 'search-notes', query: raw.trim() },
    });
  }
  return [...items, ...found].slice(0, LIMIT);
}

export function runPaletteAction(store: AppStore, action: PaletteAction): void {
  switch (action.type) {
    case 'focus-slot':
      void store.setSlotState(action.id, 'focus');
      store.setExpanded(true, { highlightSlotId: action.id });
      return;
    case 'show-task':
      store.selectTask(action.id);
      return;
    case 'search-notes':
      store.setNotesScope('all');
      store.setNotesQuery(action.query);
      return;
    case 'new-slot':
      store.requestNewSlot();
      return;
    case 'compose':
      store.requestCompose();
      return;
    case 'theme':
      store.setThemeChoice(action.theme);
      return;
    case 'language':
      void store.setLanguage(action.language);
      return;
    case 'pin':
      void store.togglePin();
      return;
    case 'sound':
      void store.toggleSound();
      return;
    case 'collapse':
      store.setExpanded(false);
      return;
    case 'reset-bar-position':
      void store.resetBarPosition();
      return;
    case 'quit':
      void store.quit();
      return;
  }
}
