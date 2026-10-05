import type {
  Dispose,
  Flashcard,
  FlashcardDeck,
  FlashcardGrade,
  FlashcardInput,
  FlashcardToday,
  UiBus,
  UiSound,
} from '@featherlog/contracts';
import { useSyncExternalStore } from 'react';

/*
 * The renderer's view of the 八股 plugin (design §17). Like every plugin's UI
 * half it keeps no state of its own that matters: the main half owns the cards
 * and the schedule, and this store only remembers what it last heard, kept
 * current by flashcards/* events.
 */

export type Snapshot = {
  /** The card on the scroll; null when nothing is due; undefined until asked. */
  current: Flashcard | null | undefined;
  /** The scroll's card shows its answer. */
  flipped: boolean;
  today: FlashcardToday | null;
  /** The deck page: the cards matching the filter, and every deck. */
  cards: Flashcard[];
  decks: FlashcardDeck[];
  filter: { deck?: string; query: string };
};

export function createFlashcardsStore(bus: UiBus, sound: UiSound) {
  let snapshot: Snapshot = { current: undefined, flipped: false, today: null, cards: [], decks: [], filter: { query: '' } };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };

  const next = async () => {
    try {
      const { card, today } = await bus.request('flashcards/next', {});
      set({ current: card, flipped: false, today });
    } catch (cause) {
      console.error('flashcards/next failed', cause);
    }
  };
  let listing = 0;
  const list = async () => {
    const mine = ++listing;
    const { deck, query } = snapshot.filter;
    try {
      const result = await bus.request('flashcards/list', { ...(deck !== undefined ? { deck } : {}), ...(query ? { query } : {}) });
      // A newer filter may have been asked for while this list was on its way.
      if (mine === listing) set({ cards: result.cards, decks: result.decks });
    } catch (cause) {
      console.error('flashcards/list failed', cause);
    }
  };

  const stops: Dispose[] = [
    bus.on('flashcards/changed', ({ card }) => {
      // The scroll's card was edited on the deck page: show the new words, keep the side it is on.
      if (snapshot.current?.id === card.id) set({ current: card });
      // A card that was not there before (or nothing was due) may be the one to show now.
      if (snapshot.current === null) void next();
      void list();
    }),
    bus.on('flashcards/deleted', ({ id }) => {
      if (snapshot.current?.id === id) void next();
      void list();
    }),
    bus.on('flashcards/imported', () => {
      if (snapshot.current === null) void next();
      void list();
    }),
    // Graded in the other window: that card is done here too.
    bus.on('flashcards/reviewed', ({ card, today }) => {
      if (snapshot.current?.id === card.id) void next();
      else set({ today });
      void list();
    }),
  ];
  void next();
  void list();

  return {
    subscribe(listener: () => void): Dispose {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    flip() {
      if (!snapshot.current || snapshot.flipped) return;
      sound.play('page');
      set({ flipped: true });
    },
    async grade(grade: FlashcardGrade) {
      const card = snapshot.current;
      if (!card || !snapshot.flipped) return;
      const { today } = await bus.request('flashcards/grade', { id: card.id, grade });
      sound.play(grade === 'again' ? 'erase' : grade === 'good' ? 'tick' : 'ink');
      set({ today });
      await next();
    },
    /** Look again: something may have come due since the scroll last asked. */
    refresh: () => void next(),
    setFilter(patch: Partial<Snapshot['filter']>) {
      set({ filter: { ...snapshot.filter, ...patch } });
      void list();
    },
    async create(input: FlashcardInput): Promise<Flashcard> {
      const { card } = await bus.request('flashcards/create', { input });
      sound.play('ink');
      return card;
    },
    async update(id: string, patch: Partial<FlashcardInput>): Promise<Flashcard> {
      const { card } = await bus.request('flashcards/update', { id, patch });
      sound.play('ink');
      return card;
    },
    async remove(id: string): Promise<void> {
      await bus.request('flashcards/delete', { id });
      sound.play('erase');
    },
    async import(text: string, deck?: string) {
      const result = await bus.request('flashcards/import', { text, ...(deck ? { deck } : {}) });
      if (result.created) sound.play('seal');
      return result;
    },
    openDeck() {
      void bus.request('shell/open-panel', { tab: 'flashcards/deck' }).catch(console.error);
    },
    dispose() {
      stops.forEach((stop) => stop());
      listeners.clear();
    },
  };
}

export type FlashcardsStore = ReturnType<typeof createFlashcardsStore>;

export function useFlashcards(store: FlashcardsStore): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** Where a grade sends the card next, in words (the box table of design §17.4). */
const SPANS = ['10 分钟后', '1 天后', '2 天后', '4 天后', '7 天后', '15 天后', '30 天后', '60 天后'];

export function nextSpan(card: Flashcard, grade: FlashcardGrade): string {
  const { box, reviews } = card.review;
  if (grade === 'again') return SPANS[0]!;
  // 模糊 keeps a card where it is; only a card never seen before moves up to the first day.
  if (grade === 'hard') return SPANS[reviews === 0 ? 1 : box]!;
  return SPANS[Math.min(7, box + 1)]!;
}
