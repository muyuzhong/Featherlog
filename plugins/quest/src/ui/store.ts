import type { ChapterDraft, Dispose, Quest, QuestInput, QuestPatch, SoundCue, UiBus, UiSound } from '@featherlog/contracts';
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
/** Lets the ink land before what it caused rings out (in step with the objective's reveal). */
const FOLLOW_UP_MS: Partial<Record<SoundCue, number>> = { unlock: 450, bell: 320, stamp: 380 };

const SILENT: UiSound = { play: () => {} };

export function createQuestStore(bus: UiBus, sound: UiSound = SILENT) {
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

  // Sounds follow this window's own actions only: every window sees the events,
  // but only the one the user touched should make a noise (design §10.1).
  const later = (cue: SoundCue) => window.setTimeout(() => sound.play(cue), FOLLOW_UP_MS[cue] ?? 0);
  const find = (id: string) => snapshot.quests.find((q) => q.id === id);
  /** What a step forward led to: the quest done, a chapter closed, or the next objective revealed. */
  const consequence = (before: Quest | undefined, after: Quest) => {
    if (after.status === 'completed' && before?.status !== 'completed') return later('stamp');
    if (before && after.derived.chapterIndex > before.derived.chapterIndex) return later('bell');
    if (after.kind === 'daily') {
      const dailies = snapshot.quests.filter((q) => q.kind === 'daily' && q.status === 'active');
      const allDone = dailies.every((q) => (q.id === after.id ? after.cycle?.done : q.cycle?.done));
      if (after.cycle?.done && allDone) later('unlock');
      return;
    }
    if (after.derived.objectiveIndex >= 0) later('unlock');
  };
  const step = (id: string, cue: SoundCue, request: () => Promise<{ quest: Quest }>) => {
    const before = find(id);
    sound.play(cue);
    return run(request().then(({ quest }) => consequence(before, quest)));
  };

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
      completeObjective: (id: string, objectiveId: string) =>
        step(id, 'ink', () => bus.request('quest/complete-objective', { id, objectiveId })),
      reopenObjective: (id: string, objectiveId: string) => {
        sound.play('erase');
        return run(bus.request('quest/reopen-objective', { id, objectiveId }));
      },
      /** A tap of the nib; the stroke that reaches the target is written in full ink. */
      count: (id: string, objectiveId?: string) => {
        const before = find(id);
        sound.play('tick');
        return run(
          bus.request('quest/count', objectiveId ? { id, objectiveId, delta: 1 } : { id, delta: 1 }).then(({ quest }) => {
            const finished = objectiveId
              ? quest.chapters.some((c) => c.objectives.some((o) => o.id === objectiveId && o.doneAt))
              : quest.cycle?.done === true && before?.cycle?.done !== true;
            if (!finished) return;
            sound.play('ink');
            consequence(before, quest);
          }),
        );
      },
      complete: (id: string) => step(id, 'ink', () => bus.request('quest/complete', { id })),
      uncomplete: (id: string) => {
        sound.play('erase');
        return run(bus.request('quest/uncomplete', { id }));
      },
      track: (id: string | null) => {
        sound.play(id ? 'seal' : 'erase');
        return run(bus.request('quest/track', { id }));
      },
      setRevealed: (id: string, revealed: boolean) => {
        sound.play('page');
        return run(bus.request('quest/update', { id, patch: { revealed } }));
      },
    },
    /**
     * Writes from the editor: these reject, so the editor can say what went wrong.
     * Responses are applied at once so the page can turn to the result without
     * waiting for the matching event (which then changes nothing).
     */
    writes: {
      create: async (input: QuestInput) => {
        const { quest } = await bus.request('quest/create', { input });
        sound.play('ink');
        upsert(quest);
        return quest;
      },
      /** Fields first, then structure: two requests, as the contract splits them. */
      save: async (id: string, edit: { patch?: QuestPatch; chapters?: ChapterDraft[] }) => {
        if (edit.patch) upsert((await bus.request('quest/update', { id, patch: edit.patch })).quest);
        if (edit.chapters) upsert((await bus.request('quest/set-chapters', { id, chapters: edit.chapters })).quest);
        sound.play('ink');
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
