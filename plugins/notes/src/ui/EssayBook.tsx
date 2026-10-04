import type { Note } from '@featherlog/contracts';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { clock, cnDay, dayOf, useNotes, type NotesStore } from './store';
import styles from './essays.module.css';

/** Saving waits for the pen to lift this long. */
const SETTLE_MS = 900;

const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '';

/** The 随笔 tab (design §15.3): an index of loose pages on the left, the open page on the right. */
export function EssayBook({ store }: { store: NotesStore }) {
  const { loaded, notes, more, filter, quests } = useNotes(store);
  // 'new' is a blank page that becomes a note with its first words.
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  // The open page keeps its key when a new page becomes a note, so writing isn't interrupted.
  const [sheetKey, setSheetKey] = useState('none');
  const open = (id: string | null) => {
    setSelected(id);
    setSheetKey(id ?? 'none');
  };
  const openNew = () => {
    setSelected('new');
    setSheetKey(`new-${Date.now()}`);
  };
  const [query, setQuery] = useState(filter.query);

  useEffect(() => {
    const timer = window.setTimeout(() => query !== filter.query && store.setFilter({ query }), 300);
    return () => window.clearTimeout(timer);
  }, [query, filter.query, store]);

  const current = selected && selected !== 'new' ? notes.find((n) => n.id === selected) : undefined;
  // Start on the newest page; fall back to it when the open one disappears.
  useEffect(() => {
    if (!loaded) return;
    if (selected === null || (selected !== 'new' && !notes.some((n) => n.id === selected))) open(notes[0]?.id ?? null);
  }, [loaded, notes, selected]);

  const days: { day: string; notes: Note[] }[] = [];
  for (const note of notes) {
    const day = dayOf(note.createdAt);
    if (days.at(-1)?.day === day) days.at(-1)!.notes.push(note);
    else days.push({ day, notes: [note] });
  }

  return (
    <div className={styles.book}>
      <div className={styles.pageWrap}>
        <section className={`${styles.page} ${styles.left} fl-paper`}>
          <header className={styles.head}>
            <h1>随笔</h1>
            <p>想到什么，就写什么</p>
          </header>
          <div className={styles.tools}>
            <button className={styles.newPage} onClick={openNew}>
              ＋ 新的一页
            </button>
            <input
              className={styles.search}
              value={query}
              placeholder="翻找……"
              aria-label="搜索随笔"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={filter.withQuestNotes}
              onChange={(event) => store.setFilter({ withQuestNotes: event.target.checked })}
            />
            <span>连同任务里的手记</span>
          </label>

          {loaded && notes.length === 0 && (
            <p className={styles.empty}>{filter.query ? '没有翻到写着这些字的页。' : '还没有随笔。点"新的一页"，写下第一笔。'}</p>
          )}
          <div className={styles.index}>
            {selected === 'new' && (
              <div className={styles.dayGroup}>
                <button className={`${styles.entry} ${styles.entryOn}`}>
                  <span className={styles.entryText}>（新的一页）</span>
                </button>
              </div>
            )}
            {days.map(({ day, notes: dayNotes }) => (
              <div key={day} className={styles.dayGroup}>
                <h2 className={styles.day}>{cnDay(day)}</h2>
                {dayNotes.map((note) => {
                  const quest = note.questId ? quests.get(note.questId) : undefined;
                  return (
                    <button
                      key={note.id}
                      className={`${styles.entry} ${note.id === selected ? styles.entryOn : ''}`}
                      onClick={() => open(note.id)}
                    >
                      <span className={styles.entryText}>{firstLine(note.text)}</span>
                      <span className={styles.entryMeta}>
                        {note.questId && <em>「{quest?.label ?? '一个任务'}」</em>}
                        {clock(note.createdAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
            {more && (
              <button className={styles.more} onClick={() => void store.loadMore().catch(console.error)}>
                更早的……
              </button>
            )}
          </div>
        </section>
      </div>
      <div className={styles.pageWrap}>
        <section className={`${styles.page} ${styles.right} fl-paper`}>
          {selected === 'new' || current ? (
            <Sheet
              key={sheetKey}
              store={store}
              note={current}
              questLabel={current?.questId ? (quests.get(current.questId)?.label ?? '一个任务') : undefined}
              onCreated={(id) => setSelected(id)}
              onDeleted={() => open(null)}
            />
          ) : (
            loaded && (
              <div className={styles.blank}>
                <p>空白的一页，等你落笔。</p>
                <button className={styles.newPage} onClick={openNew}>
                  ＋ 新的一页
                </button>
              </div>
            )
          )}
        </section>
      </div>
      <div className={styles.gutter} />
    </div>
  );
}

type SheetProps = {
  store: NotesStore;
  note: Note | undefined;
  questLabel: string | undefined;
  onCreated(id: string): void;
  onDeleted(): void;
};

/** One page, written on directly; saved when the pen lifts. */
function Sheet({ store, note, questLabel, onCreated, onDeleted }: SheetProps) {
  const [text, setText] = useState(note?.text ?? '');
  const [status, setStatus] = useState<'idle' | 'writing' | 'saved' | 'failed'>('idle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saved = useRef(note?.text ?? '');
  const id = useRef(note?.id);
  const pending = useRef<Promise<unknown> | null>(null);
  const latest = useRef(text);
  latest.current = text;

  const flush = async () => {
    const body = latest.current;
    if (!body.trim() || body.trim() === saved.current.trim()) return;
    // One write at a time: a create must finish before edits go to the new note.
    await pending.current;
    if (latest.current.trim() === saved.current.trim()) return;
    const write = id.current ? store.update(id.current, latest.current) : store.create(latest.current);
    pending.current = write;
    try {
      const written = await write;
      saved.current = written.text;
      if (!id.current) {
        id.current = written.id;
        onCreated(written.id);
      }
      setStatus('saved');
    } catch (cause) {
      console.error(cause);
      setStatus('failed');
    } finally {
      pending.current = null;
    }
  };

  useEffect(() => {
    if (text === saved.current) return;
    setStatus('writing');
    const timer = window.setTimeout(() => void flush(), SETTLE_MS);
    return () => window.clearTimeout(timer);
    // flush reads the latest text through a ref, so only the text matters here.
  }, [text]);
  // Leaving the page (another note, another tab) must not lose the last words.
  useEffect(() => () => void flush(), []);
  // An edit from another window shows up here unless this page has unsaved words.
  useEffect(() => {
    if (note && note.text !== saved.current && latest.current === saved.current) {
      saved.current = note.text;
      setText(note.text);
    }
  }, [note]);

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      void flush();
      event.currentTarget.blur();
    }
  };

  return (
    <div className={styles.sheet}>
      <div className={styles.sheetHead}>
        <span>{note ? `${cnDay(dayOf(note.createdAt))} · ${clock(note.createdAt)}` : '新的一页'}</span>
        {note && note.updatedAt !== note.createdAt && <small>改于 {clock(note.updatedAt)}</small>}
        {note?.questId && (
          <button className={styles.questLink} onClick={() => store.openQuest(note.questId!)}>
            手记 ·「{questLabel}」
          </button>
        )}
      </div>
      <textarea
        className={styles.writing}
        value={text}
        autoFocus={!note}
        placeholder="今天想到什么，就写什么……"
        aria-label="随笔正文"
        onChange={(event) => setText(event.target.value)}
        onBlur={() => void flush()}
        onKeyDown={onKey}
      />
      <footer className={styles.sheetFoot}>
        <span className={`${styles.status} ${status === 'failed' ? styles.failed : ''}`}>
          {status === 'writing' ? '写着……' : status === 'saved' ? '已记下' : status === 'failed' ? '没能记下，停笔后会再试' : ''}
        </span>
        {id.current && (
          <button
            className={`${styles.tear} ${confirmDelete ? styles.confirming : ''}`}
            onClick={() => {
              if (!confirmDelete) return setConfirmDelete(true);
              void store.remove(id.current!).then(onDeleted, (cause: unknown) => {
                console.error(cause);
                setStatus('failed');
              });
            }}
            onBlur={() => setConfirmDelete(false)}
          >
            {confirmDelete ? '再点一次，撕掉这一页' : '撕掉这一页'}
          </button>
        )}
      </footer>
    </div>
  );
}
