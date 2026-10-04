import type { Dispose, Note, UiBus, UiSound } from '@featherlog/contracts';
import { useEffect, useState, useSyncExternalStore } from 'react';

/*
 * The quest page's window onto the notes plugin (design §15): a quest's 手记,
 * over the bus. Without the notes plugin the 手记 section simply isn't shown.
 */
export function createNotesLink(bus: UiBus, sound: UiSound) {
  let present = false;
  const listeners = new Set<() => void>();
  bus.request('notes/counts', { questIds: [] }).then(
    () => {
      present = true;
      listeners.forEach((listener) => listener());
    },
    () => {},
  );
  return {
    bus,
    subscribe(listener: () => void): Dispose {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    present: () => present,
    list: async (questId: string) => (await bus.request('notes/list', { questId, limit: 200 })).notes,
    /** Writes reject, so the page can say what went wrong. */
    async create(questId: string, text: string) {
      const { note } = await bus.request('notes/create', { input: { text, questId } });
      sound.play('ink');
      return note;
    },
    update: async (id: string, text: string) => (await bus.request('notes/update', { id, text })).note,
    async remove(id: string) {
      await bus.request('notes/delete', { id });
      sound.play('erase');
    },
  };
}

export type NotesLink = ReturnType<typeof createNotesLink>;

/** A quest's 手记, newest first, kept current by notes/* events from any window. */
export function useQuestNotes(link: NotesLink, questId: string): { present: boolean; notes: Note[] } {
  const present = useSyncExternalStore(link.subscribe, link.present);
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => {
    if (!present) return;
    let alive = true;
    link.list(questId).then((found) => alive && setNotes(found), (cause) => console.error('notes/list failed', cause));
    const stops = [
      link.bus.on('notes/created', ({ note }) => {
        if (note.questId === questId) setNotes((list) => (list.some((n) => n.id === note.id) ? list : [note, ...list]));
      }),
      link.bus.on('notes/updated', ({ note }) =>
        setNotes((list) => (note.questId === questId ? list.map((n) => (n.id === note.id ? note : n)) : list.filter((n) => n.id !== note.id))),
      ),
      link.bus.on('notes/deleted', ({ id }) => setNotes((list) => list.filter((n) => n.id !== id))),
    ];
    return () => {
      alive = false;
      stops.forEach((stop) => stop());
    };
  }, [link, questId, present]);
  return { present, notes };
}
