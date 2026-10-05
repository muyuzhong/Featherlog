import type { FlashcardGrade, PreviewHost } from '@featherlog/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { nextSpan, useFlashcards, type FlashcardsStore } from './store';
import styles from './review.module.css';

const GRADES: { grade: FlashcardGrade; label: string; key: string }[] = [
  { grade: 'again', label: '忘了', key: '1' },
  { grade: 'hard', label: '模糊', key: '2' },
  { grade: 'good', label: '记得', key: '3' },
];

/** The card on the scroll (design §17.5): read the question, turn it over, say how well you knew it. */
export function ReviewCard({ store, host }: { store: FlashcardsStore; host: PreviewHost }) {
  const { current, flipped, today } = useFlashcards(store);
  const root = useRef<HTMLDivElement>(null);
  // Set once the reader clicks or types in the card. A card merely hovered must not take
  // focus, or it would hold the preview open after the pointer leaves.
  const engaged = useRef(false);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new ResizeObserver(() => host.setHeight(Math.ceil(el.getBoundingClientRect().height)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [host]);
  // Cards come due and days turn while the scroll sits there: look again whenever the
  // card appears. The shell mounts the preview afresh on each hover, so that is mount too.
  useEffect(() => {
    store.refresh();
    return host.onShow(store.refresh);
  }, [host, store]);
  // Turning the card over removes the button that had focus, and grading swaps the card:
  // keep focus on the card so 1/2/3 still reach it, unless it went somewhere else on purpose.
  useEffect(() => {
    if (!engaged.current) return;
    const active = document.activeElement;
    if (!active || active === document.body || root.current?.contains(active)) root.current?.focus({ preventScroll: true });
  }, [flipped, current?.id]);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    engaged.current = true;
    if (event.key === ' ' && !flipped) {
      event.preventDefault();
      store.flip();
      return;
    }
    const grade = GRADES.find((g) => g.key === event.key);
    if (grade && flipped) void store.grade(grade.grade).catch(console.error);
  };

  return (
    // Focusable so Space and 1/2/3 work once the card has been clicked; while it has
    // focus the scroll keeps it open (data-hold-open, design §7.2).
    <div ref={root} className={styles.card} tabIndex={-1} data-hold-open onKeyDown={onKey} onPointerDown={() => (engaged.current = true)}>
      <AnimatePresence mode="wait" initial={false}>
        {current === undefined ? null : current === null ? (
          <motion.div key="none" className={styles.rest} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            {today && today.reviewed > 0 ? (
              <>
                <span className={styles.seal}>尽数完成</span>
                <p>今天的都背完了。</p>
              </>
            ) : (
              <>
                <p>题库还空着，或者今天没有要背的。</p>
                <button className={styles.link} onClick={store.openDeck}>
                  去八股页添几题
                </button>
              </>
            )}
          </motion.div>
        ) : (
          <motion.div
            key={current.id}
            initial={{ opacity: 0, x: 18, rotate: 0.6 }}
            animate={{ opacity: 1, x: 0, rotate: 0 }}
            exit={{ opacity: 0, x: -18, rotate: -0.6 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            <div className={styles.kicker}>
              {current.deck || '八股'}
              {current.review.due === undefined && <span className={styles.fresh}>新题</span>}
            </div>
            <p className={`${styles.question} ${flipped ? styles.questionSmall : ''}`}>{current.question}</p>
            {flipped ? (
              <>
                <div className={styles.answer}>{current.answer}</div>
                <div className={styles.grades}>
                  {GRADES.map(({ grade, label, key }) => (
                    <button
                      key={grade}
                      className={`${styles.grade} ${styles[grade]}`}
                      title={`按 ${key}`}
                      onClick={() => void store.grade(grade).catch(console.error)}
                    >
                      <span>{label}</span>
                      <small>{nextSpan(current, grade)}</small>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <button className={styles.flip} onClick={store.flip} title="空格">
                翻看答案
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {today && (
        <div className={styles.today}>
          今日 {today.reviewed} · 还剩 {today.remaining}
        </div>
      )}
    </div>
  );
}
