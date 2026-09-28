import type { PreviewHost } from '@featherlog/contracts';
import { useLayoutEffect, useRef } from 'react';
import { InkBox, InkRule } from './ink';
import { Objectives, currentChapter } from './Objectives';
import { capital, cn, cnCount } from './numerals';
import { useQuests, type QuestStore } from './store';
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

  const tracked = quests.find((q) => q.tracked && q.status === 'active');
  const dailies = quests.filter((q) => q.kind === 'daily' && q.status === 'active');
  const sides = quests.filter((q) => q.kind === 'side' && q.status === 'active');
  const dueToday = sides.filter((q) => q.derived.dueToday || q.derived.overdue).length;
  const chapter = tracked && currentChapter(tracked);

  return (
    <div ref={root} className={styles.note}>
      {!loaded ? null : tracked ? (
        <>
          <div className={styles.kicker}>
            追踪中
            {tracked.kind === 'main' && chapter && (
              <span>
                第{capital(tracked.derived.chapterIndex + 1)}章 · {chapter.title}
              </span>
            )}
          </div>
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
