import type { PreviewHost } from '@featherlog/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { InkBox, InkRule, Stamp } from './ink';
import { Objectives, currentChapter } from './Objectives';
import { capital, cn, cnCount } from './numerals';
import { useQuests, type Moment, type QuestStore } from './store';
import styles from './tracker.module.css';

/** The collapsed-view preview: the tracked quest's current objective, and today's commissions. */
export function TrackerNote({ store, host }: { store: QuestStore; host: PreviewHost }) {
  const { loaded, quests } = useQuests(store);
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new ResizeObserver(() => host.setHeight(Math.ceil(el.getBoundingClientRect().height)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [host]);

  // A moment lingers on the note for a breath before the note moves on.
  const [moment, setMoment] = useState<Moment | null>(null);
  useEffect(() => store.onMoment(setMoment), [store]);
  useEffect(() => {
    if (!moment) return;
    const timer = window.setTimeout(() => setMoment(null), moment.kind === 'quest' ? 3000 : 2600);
    return () => window.clearTimeout(timer);
  }, [moment]);
  const chapterDone =
    moment?.kind === 'chapter' ? moment.quest.chapters.findIndex((c) => c.id === moment.chapterId) : -1;

  const tracked = quests.find((q) => q.tracked && q.status === 'active');
  const dailies = quests.filter((q) => q.kind === 'daily' && q.status === 'active');
  const sides = quests.filter((q) => q.kind === 'side' && q.status === 'active');
  const dueToday = sides.filter((q) => q.derived.dueToday || q.derived.overdue).length;
  const chapter = tracked && currentChapter(tracked);

  return (
    <div ref={root} className={styles.note}>
      {!loaded ? null : tracked ? (
        <>
          <AnimatePresence mode="wait" initial={false}>
            {chapterDone >= 0 && moment?.quest.id === tracked.id ? (
              <motion.div
                key="chapter-done"
                className={`${styles.kicker} ${styles.kickerDone}`}
                initial={{ opacity: 0, y: -3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                本章告成
                <span>
                  第{capital(chapterDone + 1)}章 · {moment.quest.chapters[chapterDone]!.title}
                </span>
              </motion.div>
            ) : (
              <motion.div key="tracking" className={styles.kicker} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                追踪中
                {tracked.kind === 'main' && chapter && (
                  <span>
                    第{capital(tracked.derived.chapterIndex + 1)}章 · {chapter.title}
                  </span>
                )}
              </motion.div>
            )}
          </AnimatePresence>
          <h3 className={`${styles.name} fl-ink-bleed`}>{tracked.name ?? tracked.title}</h3>
          <InkRule className={styles.rule} />
          <Objectives quest={tracked} store={store} compact />
        </>
      ) : (
        <div className={styles.empty}>
          <h3 className={styles.name}>此刻无事追踪</h3>
          <p>翻开任务日志，挑一个任务，盖上火漆。</p>
        </div>
      )}

      <AnimatePresence>
        {moment?.kind === 'quest' && (
          <motion.div
            key={moment.quest.id}
            className={styles.done}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            onClick={() => setMoment(null)}
          >
            <Stamp press size={64} />
            <span className={styles.doneName}>{moment.quest.name ?? moment.quest.title}</span>
            <span className={styles.doneLine}>任务完成</span>
          </motion.div>
        )}
      </AnimatePresence>

      <InkRule className={styles.rule} />
      <div className={styles.row}>
        <span className={styles.label}>每日委托</span>
        <span className={styles.boxes}>
          {dailies.map((d) => (
            <button
              key={d.id}
              title={d.title}
              onClick={() =>
                d.cycle?.done ? store.actions.uncomplete(d.id) : d.quota ? store.actions.count(d.id) : store.actions.complete(d.id)
              }
            >
              <InkBox checked={d.cycle?.done ?? false} />
            </button>
          ))}
        </span>
        <span className={styles.value}>
          {cn(dailies.filter((d) => d.cycle?.done).length)} / {cn(dailies.length)}
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>支线</span>
        <span className={styles.value}>
          {cnCount(sides.length)}件在身
          {dueToday > 0 && <em> · {cnCount(dueToday)}件今日限期</em>}
        </span>
      </div>
    </div>
  );
}
