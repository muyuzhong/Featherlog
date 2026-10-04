import type { Chapter, Quest } from '@featherlog/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { InkCheck, InkStrike, Quill } from './ink';
import { cnCount } from './numerals';
import type { QuestStore } from './store';
import styles from './Objectives.module.css';

/** The chapter the player is in, or the last one once the quest is done. */
export function currentChapter(quest: Quest): Chapter | undefined {
  return quest.chapters[Math.min(quest.derived.chapterIndex, quest.chapters.length - 1)];
}

type Props = { quest: Quest; store: QuestStore; compact?: boolean };

export function Objectives({ quest, store, compact = false }: Props) {
  const chapter = currentChapter(quest);
  const objectives = chapter?.objectives ?? [];
  const done = objectives.filter((o) => o.doneAt);
  const currentIndex = quest.status === 'active' ? objectives.findIndex((o) => !o.doneAt) : -1;
  const current = currentIndex >= 0 ? objectives[currentIndex] : undefined;
  const later = currentIndex >= 0 ? objectives.slice(currentIndex + 1) : [];

  // Objectives already done when this list first rendered don't replay their ink.
  const seen = useRef<Set<string> | null>(null);
  seen.current ??= new Set(done.map((o) => o.id));
  const firstRender = useRef(true);
  useEffect(() => {
    firstRender.current = false;
    done.forEach((o) => seen.current!.add(o.id));
  });

  if (!objectives.length) {
    // A side quest without objectives is a single deed.
    return quest.status === 'active' ? (
      <button className={`${styles.current} ${compact ? styles.compact : ''}`} onClick={() => store.actions.complete(quest.id)}>
        <Quill className={styles.quill} />
        <span className={styles.body}>
          <span className={styles.text}>了结此事</span>
          <span className={styles.hint}>轻点落笔</span>
        </span>
      </button>
    ) : null;
  }

  const shownDone = compact ? done.slice(-1) : done;
  return (
    <ol className={`${styles.list} ${compact ? styles.compact : ''}`}>
      {compact && done.length > 1 && <li className={styles.more}>此前已完成{cnCount(done.length - 1)}个目标</li>}
      {shownDone.map((o) => {
        const fresh = !seen.current!.has(o.id);
        return (
          <li key={o.id} className={styles.done}>
            <InkCheck animate={fresh} />
            <span className={styles.text}>
              {o.text}
              <InkStrike animate={fresh} />
            </span>
            {!compact && (
              <button className={styles.undo} onClick={() => store.actions.reopenObjective(quest.id, o.id)} title="撤回这一笔">
                撤回
              </button>
            )}
          </li>
        );
      })}

      <AnimatePresence initial={false}>
        {current && (
          <motion.li
            key={current.id}
            className={styles.unlockable}
            // The next objective soaks into the page from the left, like ink, after the stroke lands.
            initial={firstRender.current ? false : { opacity: 0, clipPath: 'inset(0 100% 0 0)', filter: 'blur(3px)' }}
            animate={{ opacity: 1, clipPath: 'inset(0 0% 0 0)', filter: 'blur(0px)' }}
            transition={{ duration: 0.75, delay: 0.45, ease: [0.22, 0.8, 0.32, 1] }}
          >
            {!firstRender.current && (
              <motion.span
                className={styles.wash}
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 1, 0] }}
                transition={{ duration: 1.8, delay: 0.5, times: [0, 0.25, 1] }}
                aria-hidden
              />
            )}
            <button
              className={styles.current}
              onClick={() =>
                current.count
                  ? store.actions.count(quest.id, current.id)
                  : store.actions.completeObjective(quest.id, current.id)
              }
            >
              <Quill className={styles.quill} />
              <span className={styles.body}>
                <span className={styles.text}>{current.text}</span>
                {current.detail && <span className={styles.detail}>{current.detail}</span>}
                {current.count && <Ticks current={current.count.current} target={current.count.target} />}
                <span className={styles.hint}>{current.count ? '轻点添一笔' : '轻点落笔'}</span>
              </span>
              {current.count && <Count {...current.count} />}
            </button>
            {current.count && !compact && (
              <SetCount
                current={current.count.current}
                target={current.count.target}
                unit={current.count.unit}
                onSet={(value) => store.actions.setCount(quest.id, current.id, value)}
              />
            )}
          </motion.li>
        )}
      </AnimatePresence>

      {later.length > 0 &&
        (quest.revealed && !compact ? (
          later.map((o) => (
            <li key={o.id} className={styles.later}>
              <span className={styles.dot} />
              <span className={styles.text}>{o.text}</span>
            </li>
          ))
        ) : (
          <li className={styles.hidden}>
            <span className={styles.ellipsis}>……</span>
            尚有{cnCount(later.length)}个目标未曾揭晓
          </li>
        ))}
    </ol>
  );
}

/** A counted objective's tally: each step bounces, with a "+1" rising off the page. */
function Count({ current, target, unit }: { current: number; target: number; unit?: string }) {
  const previous = useRef(current);
  const [rises, setRises] = useState<number[]>([]);
  useEffect(() => {
    if (current > previous.current) setRises((list) => [...list.slice(-3), current]);
    previous.current = current;
  }, [current]);
  return (
    <span className={styles.count}>
      <motion.span
        key={current}
        className={styles.tally}
        initial={rises.length ? { scale: 1.45 } : false}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 520, damping: 16 }}
      >
        {current}
      </motion.span>
      <small> / {target}{unit ?? ''}</small>
      <AnimatePresence>
        {rises.map((n) => (
          <motion.span
            key={n}
            className={styles.rise}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: [0, 1, 0], y: -22 }}
            transition={{ duration: 0.9, ease: 'easeOut' }}
            onAnimationComplete={() => setRises((list) => list.filter((m) => m !== n))}
            aria-hidden
          >
            +1
          </motion.span>
        ))}
      </AnimatePresence>
    </span>
  );
}

/** One tick per unit (a book's chapters, say), filled as they are done; a plain bar past forty. */
function Ticks({ current, target }: { current: number; target: number }) {
  const done = Math.min(current, target);
  if (target > 40) {
    return (
      <span className={styles.bar} aria-hidden>
        <span style={{ width: `${(done / target) * 100}%` }} />
      </span>
    );
  }
  return (
    <span className={styles.ticks} aria-hidden>
      {Array.from({ length: target }, (_, i) => (
        <span key={i} className={i < done ? styles.tickDone : ''} />
      ))}
    </span>
  );
}

/** "记到第几": set the count outright instead of tapping up to it. */
function SetCount({ current, target, unit, onSet }: { current: number; target: number; unit?: string; onSet(value: number): void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const commit = () => {
    const value = Number(editing);
    if (editing !== null && Number.isInteger(value) && value >= 0 && value <= target && value !== current) onSet(value);
    setEditing(null);
  };
  if (editing === null) {
    return (
      <button className={styles.setCount} onClick={() => setEditing(String(current))}>
        记到第几{unit ?? ''}
      </button>
    );
  }
  return (
    <span className={styles.setCount}>
      记到第
      <input
        autoFocus
        inputMode="numeric"
        value={editing}
        aria-label="记到第几"
        onChange={(event) => setEditing(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') {
            event.stopPropagation();
            setEditing(null);
          }
        }}
      />
      {unit ?? ''}（共 {target}）
    </span>
  );
}
