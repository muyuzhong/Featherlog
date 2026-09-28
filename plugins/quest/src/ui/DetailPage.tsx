import type { Quest } from '@featherlog/contracts';
import { Fragment, useEffect, useRef } from 'react';
import { InkCircle, Stamp, WaxSeal } from './ink';
import { Objectives, currentChapter } from './Objectives';
import { capital, cn, cnDate, dayNumber } from './numerals';
import type { QuestStore } from './store';
import styles from './journal.module.css';

/** Remembers whether `value` just flipped from false to true while mounted. */
function useJustBecame(value: boolean) {
  const previous = useRef(value);
  const flipped = value && !previous.current;
  useEffect(() => {
    previous.current = value;
  }, [value]);
  return flipped;
}

/** The right page: one quest, opened. */
export function DetailPage({ quest, store, today, onEdit }: { quest: Quest; store: QuestStore; today: string; onEdit(): void }) {
  const chapter = currentChapter(quest);
  const ci = Math.min(quest.derived.chapterIndex, quest.chapters.length - 1);
  const objectives = chapter?.objectives ?? [];
  const completed = quest.status === 'completed';
  const justTracked = useJustBecame(quest.tracked);
  const justCompleted = useJustBecame(completed);
  const hiddenLater = quest.status === 'active' && objectives.filter((o) => !o.doneAt).length > 1;

  let kicker = quest.kind === 'main' ? '主线' : '支线';
  if (quest.kind === 'main' && chapter) kicker += ` · 第${capital(ci + 1)}章 · ${chapter.title}`;
  if (quest.kind === 'side' && quest.derived.overdue) kicker += ' · 已逾期';
  else if (quest.kind === 'side' && quest.derived.dueToday && quest.deadline) kicker += ' · 今日限期';

  return (
    <div className={styles.detail}>
      {quest.kind === 'main' && <ChapterRoute quest={quest} />}

      <div className={styles.titleRow}>
        <div className={styles.titleBlock}>
          <div className={styles.kicker}>{kicker}</div>
          <h2 className={`${styles.title} ${(quest.name ?? quest.title).length > 6 ? styles.titleLong : ''} fl-ink-bleed`}>
            {quest.name ?? quest.title}
          </h2>
          {quest.name && (
            <div className={styles.realGoal}>
              真实目标 <span>·</span> {quest.title}
            </div>
          )}
        </div>
        <div className={styles.sealSlot}>
          {completed ? (
            <Stamp press={justCompleted} />
          ) : quest.tracked ? (
            <button className={styles.sealButton} onClick={() => store.actions.track(null)} title="正在追踪 · 点按取消">
              <WaxSeal press={justTracked} />
            </button>
          ) : (
            <button className={styles.trackButton} onClick={() => store.actions.track(quest.id)}>
              <InkCircle dashed />
              <span>追踪</span>
            </button>
          )}
        </div>
      </div>

      {quest.story && <p className={styles.story}>{quest.story}</p>}

      <div className={styles.objectivesHead}>
        <span>{quest.kind === 'main' ? '本章目标' : '目标'}</span>
        {hiddenLater && (
          <button onClick={() => store.actions.setRevealed(quest.id, !quest.revealed)}>
            {quest.revealed ? '收起后续' : '揭开后续'}
          </button>
        )}
      </div>
      <Objectives quest={quest} store={store} />

      <Ledger quest={quest} today={today} />
      <div className={styles.pageTools}>
        <button onClick={onEdit}>修订</button>
      </div>
    </div>
  );
}

function ChapterRoute({ quest }: { quest: Quest }) {
  const ci = quest.status === 'completed' ? quest.chapters.length : quest.derived.chapterIndex;
  return (
    <div className={styles.route}>
      {quest.chapters.map((c, i) => {
        const state = i < ci ? 'done' : i === ci ? 'current' : 'locked';
        return (
          <Fragment key={c.id}>
            {i > 0 && (
              <svg className={`${styles.link} ${i <= ci ? styles.linkWalked : ''}`} viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden>
                <path d={i % 2 ? 'M1 5.5 C 25 2.5, 45 8, 65 5 S 92 3.5, 99 5' : 'M1 5 C 22 7.5, 48 2.6, 70 5.4 S 90 6.2, 99 5'} />
              </svg>
            )}
            <div className={`${styles.node} ${styles[state]}`}>
              <span className={styles.nodeMark}>
                <InkCircle dashed={state === 'locked'} />
                <b>{capital(i + 1)}</b>
              </span>
              <span className={styles.nodeTitle}>{state === 'locked' && !quest.revealed ? '？' : c.title}</span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

function Ledger({ quest, today }: { quest: Quest; today: string }) {
  const chapter = currentChapter(quest);
  const objectives = chapter?.objectives ?? [];
  const done = objectives.filter((o) => o.doneAt).length;
  const chaptersDone = quest.chapters.filter((c) => c.doneAt).length;
  const rows: [string, string][] = [];
  if (quest.kind === 'main') {
    rows.push(['本章', `${cn(done)} / ${cn(objectives.length)}`]);
    rows.push(['全线', `${cn(chaptersDone)} / ${cn(quest.chapters.length)} 章`]);
  } else if (objectives.length) {
    rows.push(['目标', `${cn(done)} / ${cn(objectives.length)}`]);
  }
  if (quest.deadline && quest.status === 'active') rows.push(['限期', cnDate(quest.deadline)]);
  rows.push(['启程', `${cnDate(quest.createdAt)} · 第${cn(dayNumber(quest.createdAt, today))}日`]);
  if (quest.completedAt) rows.push(['功成', cnDate(quest.completedAt)]);

  return (
    <dl className={styles.ledger}>
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <span className={styles.leader} />
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
