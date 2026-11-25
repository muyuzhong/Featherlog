import { todoView } from '../lib/tasks';
import type { ThemeMode } from '../rpc/types';
import type { AppState, AppStore } from '../state/store';

export type PaletteAction =
  | { type: 'focus-slot'; id: string }
  | { type: 'show-task'; id: string }
  | { type: 'search-notes'; query: string }
  | { type: 'new-slot' }
  | { type: 'compose' }
  | { type: 'theme'; theme: ThemeMode }
  | { type: 'pin' }
  | { type: 'sound' }
  | { type: 'collapse' }
  | { type: 'quit' };

export interface PaletteItem {
  key: string;
  group: '槽位' | '待办' | '命令';
  label: string;
  hint?: string;
  action: PaletteAction;
}

const LIMIT = 9;

function matches(query: string, ...texts: Array<string | undefined>): boolean {
  if (!query) return true;
  return texts.some((t) => t?.toLowerCase().includes(query));
}

/** What Ctrl+K offers for a query: slots, the todos the panel shows, then commands. */
export function paletteItems(state: AppState, raw: string): PaletteItem[] {
  const query = raw.trim().toLowerCase();
  const items: PaletteItem[] = [];
  state.slots.forEach((slot, i) => {
    if (matches(query, slot.title, slot.tag, slot.breadcrumb)) {
      items.push({
        key: `slot:${slot.id}`,
        group: '槽位',
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
        group: '待办',
        label: task.title,
        hint: task.status === 'completed' ? '已完成' : undefined,
        action: { type: 'show-task', id: task.id },
      });
    }
  }
  const { pinned, sound, theme } = state.settings;
  const commands: PaletteItem[] = [
    { key: 'cmd:new-slot', group: '命令', label: '新建并发槽', hint: 'Alt+N', action: { type: 'new-slot' } },
    { key: 'cmd:compose', group: '命令', label: '随手记一笔', action: { type: 'compose' } },
    {
      key: 'cmd:theme',
      group: '命令',
      label: theme === 'stone' ? '换成石墨暗色' : '换成纸石浅色',
      action: { type: 'theme', theme: theme === 'stone' ? 'graphite' : 'stone' },
    },
    { key: 'cmd:pin', group: '命令', label: pinned ? '取消钉住面板' : '钉住面板', hint: 'Ctrl+P', action: { type: 'pin' } },
    { key: 'cmd:sound', group: '命令', label: sound ? '关闭音效' : '打开音效', action: { type: 'sound' } },
    { key: 'cmd:collapse', group: '命令', label: '收起到底部卡槽', hint: 'Esc', action: { type: 'collapse' } },
    { key: 'cmd:quit', group: '命令', label: '退出羽记', action: { type: 'quit' } },
  ];
  const found = commands.filter((c) => matches(query, c.label));
  if (query) {
    found.unshift({
      key: 'cmd:search-notes',
      group: '命令',
      label: `在随笔里搜「${raw.trim()}」`,
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
    case 'pin':
      void store.togglePin();
      return;
    case 'sound':
      void store.toggleSound();
      return;
    case 'collapse':
      store.setExpanded(false);
      return;
    case 'quit':
      void store.quit();
      return;
  }
}
