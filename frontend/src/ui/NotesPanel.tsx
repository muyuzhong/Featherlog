import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SPRING } from '../lib/geometry';
import { formatStamp } from '../lib/time';
import type { Note } from '../rpc/types';
import { useAppState, useNow, useStore } from '../state/react';
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
  const { notes, ui, tasks } = state;
  const contextId = store.notesContextTaskId(state);
  const contextTask = contextId ? tasks.find((t) => t.id === contextId) : undefined;
  const titleOf = (id: string | null) => (id ? tasks.find((t) => t.id === id)?.title : undefined);
  const blocked = ui.notesScope === 'focus' && !contextId;

  return (
    <section className="panel notes" aria-label="随笔与手记">
      <div className="panel-head">
        <Segmented<NotesScope>
          id="notes-scope"
          label="随笔范围"
          value={ui.notesScope}
          onChange={(s) => store.setNotesScope(s)}
          options={[
            { value: 'all', label: '全部随笔' },
            { value: 'focus', label: '焦点手记' },
          ]}
        />
        <label className="mini-search">
          <Search />
          <input
            aria-label="搜索随笔"
            placeholder="搜索"
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
              <span>挂在</span>
              <strong>{contextTask.title}</strong>
              {ui.selectedTaskId && (
                <button type="button" className="icon-btn tiny" aria-label="改回焦点槽位的任务" onClick={() => store.selectTask(null)}>
                  <X />
                </button>
              )}
            </>
          ) : (
            <span>焦点槽位没关联任务：在左边点一个任务，或把任务「上台」。</span>
          )}
        </div>
      )}
      <Composer disabled={blocked} />
      <ul className="note-list" aria-label="随笔">
        <AnimatePresence initial={false}>
          {notes.map((note) => (
            <NoteItem key={note.id} note={note} taskTitle={ui.notesScope === 'all' ? titleOf(note.taskId) : undefined} />
          ))}
        </AnimatePresence>
        {notes.length === 0 && !blocked && (
          <li className="empty">{ui.notesQuery.trim() ? '没有匹配的随笔。' : '还没有随笔，落一笔吧。'}</li>
        )}
      </ul>
    </section>
  );
}

function Composer({ disabled }: { disabled: boolean }) {
  const store = useStore();
  const { ui } = useAppState();
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
        aria-label="新随笔"
        placeholder={ui.notesScope === 'focus' ? '给这件事记一笔…' : '随手记…'}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" className="text-btn strong" disabled={disabled || !text.trim() || saving} onClick={() => void save()}>
        存下 <kbd>Ctrl ↵</kbd>
      </button>
    </div>
  );
}

function NoteItem({ note, taskTitle }: { note: Note; taskTitle?: string }) {
  const store = useStore();
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
          <span className="note-task" title={`手记：${taskTitle}`}>
            <ArrowUpRight />
            {taskTitle}
          </span>
        )}
        {status === 'saved' && !editing && <span className="saved">已存</span>}
        <span className="spacer" />
        {confirm ? (
          <button type="button" className="text-btn strong" onClick={() => void store.deleteNote(note.id)}>
            确认删除
          </button>
        ) : (
          <button type="button" className="icon-btn tiny note-delete" aria-label="删除这条随笔" onClick={() => setConfirm(true)}>
            <Trash />
          </button>
        )}
      </div>
      <textarea
        ref={ref}
        className="note-body"
        rows={1}
        aria-label="随笔内容"
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
