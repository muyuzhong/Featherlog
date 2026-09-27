import type { Chapter, Quest } from '@featherlog/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
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
            initial={firstRender.current ? false : { opacity: 0, y: 5, filter: 'blur(3px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.7, delay: 0.45, ease: [0.22, 0.8, 0.32, 1] }}
          >
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
                <span className={styles.hint}>{current.count ? '轻点添一笔' : '轻点落笔'}</span>
              </span>
              {current.count && (
                <span className={styles.count}>
                  {current.count.current}
                  <small> / {current.count.target}{current.count.unit ?? ''}</small>
                </span>
              )}
            </button>
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
