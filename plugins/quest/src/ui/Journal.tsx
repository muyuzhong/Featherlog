import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { DetailPage } from './DetailPage';
import { InkRule, Stamp } from './ink';
import { ListPage } from './ListPage';
import { capital, dayNumber, localToday } from './numerals';
import { useQuests, type Moment, type QuestStore } from './store';
import styles from './journal.module.css';

const MOMENT_MS = { chapter: 2600, quest: 3600 };

/** The panel tab: the quest journal as an open book. */
export function Journal({ store }: { store: QuestStore }) {
  const { loaded, quests } = useQuests(store);
  const [selectedId, setSelectedId] = useState<string>();
  const [moment, setMoment] = useState<Moment | null>(null);

  useEffect(() => store.onMoment(setMoment), [store]);
  useEffect(() => {
    if (!moment) return;
    const timer = window.setTimeout(() => setMoment(null), MOMENT_MS[moment.kind]);
    return () => window.clearTimeout(timer);
  }, [moment]);

  const readable = quests.filter((q) => q.kind !== 'daily');
  const selected =
    readable.find((q) => q.id === selectedId) ??
    readable.find((q) => q.tracked) ??
    readable.find((q) => q.status === 'active' && q.kind === 'main') ??
    readable.find((q) => q.status === 'active');
  // The quest plugin decides what "today" is; any daily carries its period key.
  const today = quests.find((q) => q.cycle)?.cycle?.periodKey ?? localToday();
  const start = quests.reduce<string | undefined>((min, q) => (!min || q.createdAt < min ? q.createdAt : min), undefined);
  const day = start ? dayNumber(start, today) : 1;

  return (
    <div className={styles.journal}>
      <div className={styles.book}>
        <div className={styles.pageWrap}>
          <section className={`${styles.page} ${styles.left} fl-paper`}>
            {loaded && (
              <ListPage quests={quests} selectedId={selected?.id} today={today} day={day} store={store} onSelect={setSelectedId} />
            )}
          </section>
        </div>
        <div className={styles.pageWrap}>
          <section className={`${styles.page} ${styles.right} fl-paper`}>
            <AnimatePresence mode="wait" initial={false}>
              {selected && (
                <motion.div
                  key={selected.id}
                  className={styles.detailMotion}
                  initial={{ opacity: 0, x: 10, filter: 'blur(2px)' }}
                  animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, x: -8, filter: 'blur(2px)' }}
                  transition={{ duration: 0.28, ease: [0.22, 0.8, 0.32, 1] }}
                >
                  <DetailPage quest={selected} store={store} today={today} />
                </motion.div>
              )}
            </AnimatePresence>
            {loaded && !selected && <p className={styles.blank}>日志尚空，等你写下第一个任务。</p>}
          </section>
        </div>
        <div className={styles.gutter} />
      </div>
      <Ceremony moment={moment} onDismiss={() => setMoment(null)} />
    </div>
  );
}

function Ceremony({ moment, onDismiss }: { moment: Moment | null; onDismiss(): void }) {
  const chapter =
    moment?.kind === 'chapter' ? moment.quest.chapters.findIndex((c) => c.id === moment.chapterId) : -1;
  return (
    <AnimatePresence>
      {moment?.kind === 'quest' && (
        <motion.div
          key="quest"
          className={styles.ceremony}
          onClick={onDismiss}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
        >
          <motion.div
            className={styles.ceremonyShadow}
            initial={{ y: 16, scale: 0.97 }}
            animate={{ y: 0, scale: 1 }}
            transition={{ duration: 0.6, ease: [0.22, 0.8, 0.32, 1] }}
          >
            <div className={`${styles.ceremonyCard} fl-paper`}>
              <div className={styles.ceremonyKicker}>任务完成</div>
              <h3 className="fl-ink-bleed">{moment.quest.name ?? moment.quest.title}</h3>
              {moment.quest.name && <p>{moment.quest.title}</p>}
              <InkRule />
              <div className={styles.ceremonyStamp}>
                <Stamp press size={78} />
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
      {moment?.kind === 'chapter' && chapter >= 0 && (
        <motion.div
          key="chapter"
          className={styles.chapterBanner}
          initial={{ opacity: 0, y: -8, filter: 'blur(3px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -4, filter: 'blur(3px)' }}
          transition={{ duration: 0.6, ease: [0.22, 0.8, 0.32, 1] }}
        >
          <div className={`${styles.chapterBannerPaper} fl-paper`}>
            <span className={styles.chapterBannerKicker}>本章告成</span>
            <span className="fl-ink-bleed">
              第{capital(chapter + 1)}章 · {moment.quest.chapters[chapter]!.title}
            </span>
            {moment.quest.chapters[chapter + 1] && (
              <small>下一章「{moment.quest.chapters[chapter + 1]!.title}」已经展开</small>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
