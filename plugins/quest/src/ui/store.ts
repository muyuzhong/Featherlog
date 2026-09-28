import type { ChapterDraft, Dispose, Quest, QuestInput, QuestPatch, UiBus } from '@featherlog/contracts';
import { useSyncExternalStore } from 'react';

/** A moment worth a ceremony. */
export type Moment =
  | { kind: 'chapter'; quest: Quest; chapterId: string }
  | { kind: 'quest'; quest: Quest };

export type Snapshot = { loaded: boolean; quests: Quest[] };

/**
 * The renderer's view of the quest plugin's data: filled by "quest/list" and kept
 * current by quest/* events. It holds no state of its own beyond that (design §5.1).
 */
export function createQuestStore(bus: UiBus) {
  let snapshot: Snapshot = { loaded: false, quests: [] };
  const listeners = new Set<() => void>();
  const momentListeners = new Set<(moment: Moment) => void>();
  const stops: Dispose[] = [];

  const commit = (quests: Quest[], loaded = true) => {
    snapshot = { loaded, quests };
    listeners.forEach((listener) => listener());
  };
  const upsert = (quest: Quest) => {
    const exists = snapshot.quests.some((q) => q.id === quest.id);
    commit(exists ? snapshot.quests.map((q) => (q.id === quest.id ? quest : q)) : [...snapshot.quests, quest]);
  };
  const reload = async () => {
    try {
      const { quests } = await bus.request('quest/list', {});
      commit(quests);
    } catch (cause) {
      console.error('quest/list failed', cause);
    }
  };
  const moment = (m: Moment) => momentListeners.forEach((listener) => listener(m));

  const upsertOn = [
    'quest/created',
    'quest/updated',
    'quest/objective-completed',
    'quest/objective-reopened',
    'quest/uncompleted',
    'quest/counted',
  ] as const;
  for (const type of upsertOn) stops.push(bus.on(type, ({ quest }) => upsert(quest)));
  stops.push(
    bus.on('quest/chapter-completed', ({ quest, chapterId }) => {
      upsert(quest);
      if (quest.status === 'active') moment({ kind: 'chapter', quest, chapterId });
    }),
    bus.on('quest/completed', ({ quest }) => {
      upsert(quest);
      if (quest.kind !== 'daily') moment({ kind: 'quest', quest });
    }),
    bus.on('quest/tracked', ({ questId }) => commit(snapshot.quests.map((q) => ({ ...q, tracked: q.id === questId })))),
    bus.on('quest/deleted', ({ id }) => commit(snapshot.quests.filter((q) => q.id !== id))),
    bus.on('quest/period-rolled', () => void reload()),
  );
  void reload();

  const run = (promise: Promise<unknown>) => promise.catch((cause) => console.error(cause));

  return {
    subscribe(listener: () => void): Dispose {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    onMoment(listener: (moment: Moment) => void): Dispose {
      momentListeners.add(listener);
      return () => momentListeners.delete(listener);
    },
    actions: {
      completeObjective: (id: string, objectiveId: string) => run(bus.request('quest/complete-objective', { id, objectiveId })),
      reopenObjective: (id: string, objectiveId: string) => run(bus.request('quest/reopen-objective', { id, objectiveId })),
      count: (id: string, objectiveId?: string) =>
        run(bus.request('quest/count', objectiveId ? { id, objectiveId, delta: 1 } : { id, delta: 1 })),
      complete: (id: string) => run(bus.request('quest/complete', { id })),
      uncomplete: (id: string) => run(bus.request('quest/uncomplete', { id })),
      track: (id: string | null) => run(bus.request('quest/track', { id })),
      setRevealed: (id: string, revealed: boolean) => run(bus.request('quest/update', { id, patch: { revealed } })),
    },
    /**
     * Writes from the editor: these reject, so the editor can say what went wrong.
     * Responses are applied at once so the page can turn to the result without
     * waiting for the matching event (which then changes nothing).
     */
    writes: {
      create: async (input: QuestInput) => {
        const { quest } = await bus.request('quest/create', { input });
        upsert(quest);
        return quest;
      },
      /** Fields first, then structure: two requests, as the contract splits them. */
      save: async (id: string, edit: { patch?: QuestPatch; chapters?: ChapterDraft[] }) => {
        if (edit.patch) upsert((await bus.request('quest/update', { id, patch: edit.patch })).quest);
        if (edit.chapters) upsert((await bus.request('quest/set-chapters', { id, chapters: edit.chapters })).quest);
      },
      archive: (id: string) => bus.request('quest/archive', { id }),
      remove: (id: string) => bus.request('quest/delete', { id }),
    },
    dispose() {
      stops.forEach((stop) => stop());
      listeners.clear();
      momentListeners.clear();
    },
  };
}

export type QuestStore = ReturnType<typeof createQuestStore>;

export function useQuests(store: QuestStore): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
