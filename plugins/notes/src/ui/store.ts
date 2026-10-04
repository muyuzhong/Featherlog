import type { Dispose, Note, Quest, UiBus, UiSound } from '@featherlog/contracts';
import { useSyncExternalStore } from 'react';

/*
 * The renderer's view of the notes plugin (design §15): the page of notes the
 * 随笔 tab is showing, kept current by notes/* events, and enough of the quests
 * (names, the tracked one) to label 手记 and to file a quick note.
 */

export type QuestLabel = { id: string; label: string; tracked: boolean; active: boolean };

export type Filter = {
  /** Also show quests' 手记, not only 随笔. */
  withQuestNotes: boolean;
  query: string;
};

export type Snapshot = {
  loaded: boolean;
  notes: Note[];
  more: boolean;
  filter: Filter;
  quests: Map<string, QuestLabel>;
};

const PAGE = 50;

const label = (quest: Quest): QuestLabel => ({
  id: quest.id,
  label: quest.name ?? quest.title,
  tracked: quest.tracked,
  active: quest.status === 'active',
});

export function createNotesStore(bus: UiBus, sound: UiSound) {
  let snapshot: Snapshot = { loaded: false, notes: [], more: false, filter: { withQuestNotes: false, query: '' }, quests: new Map() };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const matches = (note: Note, filter = snapshot.filter) =>
    (filter.withQuestNotes || note.questId === undefined) &&
    (!filter.query || note.text.toLowerCase().includes(filter.query.toLowerCase()));

  let generation = 0;
  const load = async () => {
    const mine = ++generation;
    const { filter } = snapshot;
    try {
      const { notes, more } = await bus.request('notes/list', {
        ...(filter.withQuestNotes ? {} : { questId: null }),
        ...(filter.query ? { query: filter.query } : {}),
        limit: PAGE,
      });
      // A newer filter may have been asked for while this page was on its way.
      if (mine === generation) set({ loaded: true, notes, more });
    } catch (cause) {
      console.error('notes/list failed', cause);
      if (mine === generation) set({ loaded: true });
    }
  };
  const loadQuests = async () => {
    try {
      const { quests } = await bus.request('quest/list', {});
      set({ quests: new Map(quests.map((q) => [q.id, label(q)])) });
    } catch {
      // Without the quest plugin there are no 手记 to label; 随笔 still work.
    }
  };

  const stops: Dispose[] = [
    bus.on('notes/created', ({ note }) => {
      if (matches(note) && !snapshot.notes.some((n) => n.id === note.id)) set({ notes: [note, ...snapshot.notes] });
    }),
    bus.on('notes/updated', ({ note }) => {
      const known = snapshot.notes.some((n) => n.id === note.id);
      if (known && !matches(note)) set({ notes: snapshot.notes.filter((n) => n.id !== note.id) });
      else if (known) set({ notes: snapshot.notes.map((n) => (n.id === note.id ? note : n)) });
      // A 手记 that became a 随笔 (its quest was deleted) now belongs on the page.
      else if (matches(note)) set({ notes: [...snapshot.notes, note].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    }),
    bus.on('notes/deleted', ({ id }) => set({ notes: snapshot.notes.filter((n) => n.id !== id) })),
    bus.on('quest/created', ({ quest }) => set({ quests: new Map(snapshot.quests).set(quest.id, label(quest)) })),
    bus.on('quest/updated', ({ quest }) => set({ quests: new Map(snapshot.quests).set(quest.id, label(quest)) })),
    bus.on('quest/deleted', ({ id }) => {
      const quests = new Map(snapshot.quests);
      quests.delete(id);
      set({ quests });
    }),
    bus.on('quest/tracked', () => void loadQuests()),
  ];
  void load();
  void loadQuests();

  return {
    subscribe(listener: () => void): Dispose {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    setFilter(patch: Partial<Filter>) {
      set({ filter: { ...snapshot.filter, ...patch } });
      void load();
    },
    async loadMore() {
      const last = snapshot.notes.at(-1);
      if (!last || !snapshot.more) return;
      const { filter } = snapshot;
      const { notes, more } = await bus.request('notes/list', {
        ...(filter.withQuestNotes ? {} : { questId: null }),
        ...(filter.query ? { query: filter.query } : {}),
        before: last.createdAt,
        limit: PAGE,
      });
      set({ notes: [...snapshot.notes, ...notes.filter((n) => !snapshot.notes.some((m) => m.id === n.id))], more });
    },
    /** Writes reject, so the page can say what went wrong; the matching event updates the list. */
    async create(text: string, questId?: string): Promise<Note> {
      const { note } = await bus.request('notes/create', { input: { text, ...(questId ? { questId } : {}) } });
      sound.play('ink');
      return note;
    },
    async update(id: string, text: string): Promise<Note> {
      return (await bus.request('notes/update', { id, text })).note;
    },
    async remove(id: string): Promise<void> {
      await bus.request('notes/delete', { id });
      sound.play('erase');
    },
    openQuest(questId: string) {
      void bus.request('shell/open-panel', { tab: 'quest/journal', params: { questId } }).catch(console.error);
    },
    dispose() {
      stops.forEach((stop) => stop());
      listeners.clear();
    },
  };
}

export type NotesStore = ReturnType<typeof createNotesStore>;

export function useNotes(store: NotesStore): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

const DIGITS = '〇一二三四五六七八九';
const cn = (n: number) =>
  n < 10 ? DIGITS[n]! : n < 20 ? `十${n % 10 ? DIGITS[n % 10] : ''}` : `${DIGITS[Math.floor(n / 10)]}十${n % 10 ? DIGITS[n % 10] : ''}`;

/** The local day a note was written on, as a grouping key: "2026-10-04". */
export const dayOf = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** "2026-10-04" → 十月四日 */
export const cnDay = (day: string) => {
  const [, month, date] = day.split('-').map(Number);
  return `${cn(month!)}月${cn(date!)}日`;
};

export const clock = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
