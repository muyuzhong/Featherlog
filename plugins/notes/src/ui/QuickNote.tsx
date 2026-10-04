import type { PreviewHost } from '@featherlog/contracts';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNotes, type NotesStore } from './store';
import styles from './quick.module.css';

/** The scroll's quick note (design §15.3): write a line now, as a 随笔 or into the tracked quest. */
export function QuickNote({ store, host }: { store: NotesStore; host: PreviewHost }) {
  const { quests } = useNotes(store);
  const root = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [intoQuest, setIntoQuest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [trouble, setTrouble] = useState<string>();
  const tracked = [...quests.values()].find((q) => q.tracked && q.active);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new ResizeObserver(() => host.setHeight(Math.ceil(el.getBoundingClientRect().height)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [host]);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(undefined), 3000);
    return () => window.clearTimeout(timer);
  }, [done]);

  const write = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setTrouble(undefined);
    const quest = intoQuest && tracked ? tracked : undefined;
    try {
      await store.create(body, quest?.id);
      setText('');
      setDone(quest ? `已记到「${quest.label}」` : '已记作随笔');
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
  };

  return (
    <div ref={root} className={styles.note}>
      <div className={styles.kicker}>随时记一笔</div>
      <textarea
        className={styles.writing}
        value={text}
        rows={3}
        disabled={busy}
        placeholder="想到什么，就写下来……"
        aria-label="随时记一笔"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKey}
      />
      <div className={styles.row}>
        <span className={styles.chips} role="radiogroup" aria-label="记到哪里">
          <button role="radio" aria-checked={!intoQuest || !tracked} className={!intoQuest || !tracked ? styles.on : ''} onClick={() => setIntoQuest(false)}>
            随笔
          </button>
          {tracked && (
            <button role="radio" aria-checked={intoQuest} className={intoQuest ? styles.on : ''} onClick={() => setIntoQuest(true)}>
              记到「{tracked.label}」
            </button>
          )}
        </span>
        <button className={styles.write} disabled={busy || !text.trim()} onClick={() => void write()} title="Ctrl + Enter">
          落笔
        </button>
      </div>
      {(done || trouble) && <p className={`${styles.after} ${trouble ? styles.trouble : ''}`}>{trouble ?? done}</p>}
    </div>
  );
}
