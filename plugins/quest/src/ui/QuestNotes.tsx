import type { Note } from '@featherlog/contracts';
import { useState, type KeyboardEvent } from 'react';
import { cnCount, cnDate } from './numerals';
import type { NotesLink } from './notes-link';
import styles from './notes.module.css';

const SHOWN = 3;
const clock = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

/** A quest's 手记 (design §15.3): what was done and learned along the way, newest first. */
export function QuestNotes({ link, questId, notes }: { link: NotesLink; questId: string; notes: Note[] }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string>();
  const [all, setAll] = useState(false);

  const write = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setTrouble(undefined);
    try {
      await link.create(questId, body);
      setDraft('');
    } catch (cause) {
      console.error(cause);
      setTrouble('没能记下，请再试一次');
    } finally {
      setBusy(false);
    }
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void write();
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      setDraft('');
      event.currentTarget.blur();
    }
  };

  const shown = all ? notes : notes.slice(0, SHOWN);
  return (
    <section className={styles.notes}>
      <div className={styles.head}>
        <span>手记</span>
        {notes.length > SHOWN && (
          <button onClick={() => setAll(!all)}>{all ? '只看最近' : `全部${cnCount(notes.length)}则`}</button>
        )}
      </div>
      <div className={styles.composer}>
        <textarea
          value={draft}
          rows={1}
          disabled={busy}
          placeholder="记下这一步做了什么、学到了什么……"
          aria-label="记一笔手记"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKey}
        />
        {draft.trim() && (
          <button className={styles.write} disabled={busy} onClick={() => void write()} title="Ctrl + Enter">
            落笔
          </button>
        )}
      </div>
      {trouble && <p className={styles.trouble}>{trouble}</p>}
      <ol className={styles.list}>
        {shown.map((note) => (
          <Entry key={note.id} link={link} note={note} />
        ))}
      </ol>
    </section>
  );
}

function Entry({ link, note }: { link: NotesLink; note: Note }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const save = async () => {
    if (editing === null) return;
    const body = editing.trim();
    if (body && body !== note.text) await link.update(note.id, body).catch((cause: unknown) => console.error(cause));
    setEditing(null);
  };
  return (
    <li className={styles.entry}>
      <div className={styles.when}>
        {cnDate(note.createdAt)} · {clock(note.createdAt)}
        <span className={styles.tools}>
          {editing === null && <button onClick={() => setEditing(note.text)}>改</button>}
          <button
            className={confirm ? styles.confirming : ''}
            onBlur={() => setConfirm(false)}
            onClick={() => (confirm ? void link.remove(note.id).catch((cause: unknown) => console.error(cause)) : setConfirm(true))}
          >
            {confirm ? '再点一次删去' : '删'}
          </button>
        </span>
      </div>
      {editing === null ? (
        <p className={styles.text}>{note.text}</p>
      ) : (
        <textarea
          className={styles.editing}
          value={editing}
          autoFocus
          aria-label="修改手记"
          onChange={(event) => setEditing(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void save();
            if (event.key === 'Escape') {
              event.stopPropagation();
              setEditing(null);
            }
          }}
        />
      )}
    </li>
  );
}
