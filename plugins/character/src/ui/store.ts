import type { CharacterSheet, ChronicleEntry, Dispose, UiBus, UiSound } from '@featherlog/contracts';
import { useSyncExternalStore } from 'react';

/*
 * The renderer's view of the character plugin (design §16): the sheet as the
 * main half last published it, and as much of the chronicle as has been read.
 */

export type Snapshot = {
  sheet: CharacterSheet | null;
  chronicle: ChronicleEntry[];
  more: boolean;
  /** First line of 翎's epilogue per completed main quest; null when there is none or no 翎. */
  epilogues: Map<string, string | null>;
};

const PAGE = 50;

const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '';

export function createCharacterStore(bus: UiBus, sound: UiSound) {
  let snapshot: Snapshot = { sheet: null, chronicle: [], more: false, epilogues: new Map() };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const asking = new Set<string>();

  const loadSheet = () =>
    bus.request('character/sheet', {}).then((sheet) => set({ sheet }), (cause) => console.error('character/sheet failed', cause));
  // The newest page, merged over what is already read: new entries arrive at the top.
  const loadNewest = () =>
    bus.request('character/chronicle', { limit: PAGE }).then(
      ({ entries, more }) => {
        const known = new Set(entries.map((e) => e.id));
        const older = snapshot.chronicle.filter((e) => !known.has(e.id));
        set({ chronicle: [...entries, ...older], more: older.length ? snapshot.more : more });
      },
      (cause) => console.error('character/chronicle failed', cause),
    );

  const stops: Dispose[] = [
    bus.on('character/changed', ({ sheet }) => {
      set({ sheet });
      void loadNewest();
    }),
  ];
  void loadSheet();
  void loadNewest();

  return {
    subscribe(listener: () => void): Dispose {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    async loadMore() {
      const last = snapshot.chronicle.at(-1);
      if (!last || !snapshot.more) return;
      // A page may run past `limit` to keep entries of one instant together (design §16.6).
      const { entries, more } = await bus.request('character/chronicle', { before: last.at, limit: PAGE });
      const known = new Set(snapshot.chronicle.map((e) => e.id));
      set({ chronicle: [...snapshot.chronicle, ...entries.filter((e) => !known.has(e.id))], more });
    },
    async wear(titleId: string | null) {
      const sheet = await bus.request('character/wear', { titleId });
      if (titleId) sound.play('seal');
      set({ sheet });
    },
    /** Asks 翎 once per quest; without 翎 the request has no handler and the line stays empty. */
    epilogue(questId: string) {
      if (snapshot.epilogues.has(questId) || asking.has(questId)) return;
      asking.add(questId);
      bus.request('scribe/epilogue', { questId }).then(
        ({ epilogue }) => set({ epilogues: new Map(snapshot.epilogues).set(questId, epilogue ? firstLine(epilogue.text) : null) }),
        () => set({ epilogues: new Map(snapshot.epilogues).set(questId, null) }),
      );
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

export type CharacterStore = ReturnType<typeof createCharacterStore>;

export function useCharacter(store: CharacterStore): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
