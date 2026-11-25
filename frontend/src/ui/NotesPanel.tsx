import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SPRING } from '../lib/geometry';
import { formatStamp } from '../lib/time';
import type { Note } from '../rpc/types';
import { useAppState, useNow, useStore, useT } from '../state/react';
import type { NotesScope } from '../state/store';
import { Segmented } from './bits';
import { ArrowUpRight, Search, Trash, X } from './icons';
import { isImeKey } from './InlineText';

const AUTOSAVE_MS = 700;
const CONFIRM_MS = 3000;

/** Grow a textarea with its text, as paper does, instead of scrolling inside it. */
function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}

/** The lower right: loose notes, or the notes of the task in focus, written straight onto the page. */
export function NotesPanel() {
  const store = useStore();
  const state = useAppState();
  const t = useT();
  const { notes, ui, tasks } = state;
  const contextId = store.notesContextTaskId(state);
  const contextTask = contextId ? tasks.find((task) => task.id === contextId) : undefined;
  const titleOf = (id: string | null) => (id ? tasks.find((task) => task.id === id)?.title : undefined);
  const blocked = ui.notesScope === 'focus' && !contextId;

  return (
    <section className="panel notes" aria-label={t.notes.region}>
      <div className="panel-head">
        <Segmented<NotesScope>
          id="notes-scope"
          label={t.notes.scope}
          value={ui.notesScope}
          onChange={(s) => store.setNotesScope(s)}
          options={[
            { value: 'all', label: t.notes.all },
            { value: 'focus', label: t.notes.focus },
          ]}
        />
        <label className="mini-search">
          <Search />
          <input
            aria-label={t.notes.search}
            placeholder={t.notes.searchPlaceholder}
            value={ui.notesQuery}
            spellCheck={false}
            onChange={(e) => store.setNotesQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && ui.notesQuery) {
                e.stopPropagation();
                store.setNotesQuery('');
              }
            }}
          />
        </label>
      </div>
      {ui.notesScope === 'focus' && (
        <div className="notes-context">
          {contextTask ? (
            <>
              <span>{t.notes.on}</span>
              <strong>{contextTask.title}</strong>
              {ui.selectedTaskId && (
                <button type="button" className="icon-btn tiny" aria-label={t.notes.backToFocus} onClick={() => store.selectTask(null)}>
                  <X />
                </button>
              )}
            </>
          ) : (
            <span>{t.notes.noContext}</span>
          )}
        </div>
      )}
      <Composer disabled={blocked} />
      <ul className="note-list" aria-label={t.notes.list}>
        <AnimatePresence initial={false}>
          {notes.map((note) => (
            <NoteItem key={note.id} note={note} taskTitle={ui.notesScope === 'all' ? titleOf(note.taskId) : undefined} />
          ))}
        </AnimatePresence>
        {notes.length === 0 && !blocked && (
          <li className="empty">{ui.notesQuery.trim() ? t.notes.noMatch : t.notes.empty}</li>
        )}
      </ul>
    </section>
  );
}

function Composer({ disabled }: { disabled: boolean }) {
  const store = useStore();
  const { ui } = useAppState();
  const t = useT();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutosize(ref, text);

  useEffect(() => {
    if (ui.composeSignal > 0) ref.current?.focus();
  }, [ui.composeSignal]);

  const save = async () => {
    if (saving || !text.trim()) return;
    setSaving(true);
    const ok = await store.createNote(text);
    setSaving(false);
    if (ok) setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeKey(e)) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape' && text) {
      e.stopPropagation();
      e.currentTarget.blur();
    }
  };

  return (
    <div className="composer" data-disabled={disabled || undefined}>
      <textarea
        ref={ref}
        rows={1}
        aria-label={t.notes.composer}
        placeholder={ui.notesScope === 'focus' ? t.notes.composeFocus : t.notes.composeAll}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" className="text-btn strong" disabled={disabled || !text.trim() || saving} onClick={() => void save()}>
        {t.notes.save} <kbd>Ctrl ↵</kbd>
      </button>
    </div>
  );
}

function NoteItem({ note, taskTitle }: { note: Note; taskTitle?: string }) {
  const store = useStore();
  const t = useT();
  const now = useNow(60_000);
  const [draft, setDraft] = useState(note.content);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved'>('idle');
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const cancelSave = useRef<(() => void) | null>(null);
  const latest = useRef(note.content);
  useAutosize(ref, draft);

  useEffect(() => {
    latest.current = note.content;
    if (!editing) setDraft(note.content);
  }, [note.content, editing]);

  useEffect(() => () => cancelSave.current?.(), []);

  useEffect(() => {
    if (!confirm) return;
    return store.clock.setTimeout(() => setConfirm(false), CONFIRM_MS);
  }, [confirm, store]);

  const flush = async (text: string) => {
    cancelSave.current?.();
    cancelSave.current = null;
    const next = text.trim();
    // An emptied note is not saved: deleting is its own, confirmed act.
    if (!next || next === latest.current.trim()) return;
    latest.current = next;
    if (await store.updateNote(note.id, next)) setStatus('saved');
  };

  const schedule = (text: string) => {
    cancelSave.current?.();
    setStatus('idle');
    cancelSave.current = store.clock.setTimeout(() => void flush(text), AUTOSAVE_MS);
  };

  return (
    <motion.li
      layout="position"
      className="note"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.1 } }}
      transition={SPRING}
    >
      <div className="note-head">
        <span className="stamp tnum">{formatStamp(note.createdAt, now)}</span>
        {taskTitle && (
          <span className="note-task" title={t.notes.taskNote(taskTitle)}>
            <ArrowUpRight />
            {taskTitle}
          </span>
        )}
        {status === 'saved' && !editing && <span className="saved">{t.notes.saved}</span>}
        <span className="spacer" />
        {confirm ? (
          <button type="button" className="text-btn strong" onClick={() => void store.deleteNote(note.id)}>
            {t.notes.confirmDelete}
          </button>
        ) : (
          <button type="button" className="icon-btn tiny note-delete" aria-label={t.notes.delete} onClick={() => setConfirm(true)}>
            <Trash />
          </button>
        )}
      </div>
      <textarea
        ref={ref}
        className="note-body"
        rows={1}
        aria-label={t.notes.body}
        value={draft}
        spellCheck={false}
        onFocus={() => setEditing(true)}
        onBlur={(e) => {
          setEditing(false);
          void flush(e.currentTarget.value);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          schedule(e.target.value);
        }}
        onKeyDown={(e) => {
          if (isImeKey(e)) return;
          if (e.key === 'Escape') {
            e.stopPropagation();
            e.currentTarget.blur();
          }
        }}
      />
    </motion.li>
  );
}
