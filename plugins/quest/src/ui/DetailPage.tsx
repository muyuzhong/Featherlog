import type { ObjectiveDraft, Quest, ScribeEpilogue, ScribeLine } from '@featherlog/contracts';
import { Fragment, useEffect, useRef, useState } from 'react';
import { attributeName } from './attributes';
import { ScribeWords } from './ScribeBits';
import { useQuestNotes, type NotesLink } from './notes-link';
import { QuestNotes } from './QuestNotes';
import { canAsk, scribeTrouble, useScribe, type ScribeLink } from './scribe-link';
import scribeStyles from './scribe.module.css';
import { InkCircle, Stamp, WaxSeal } from './ink';
import { Objectives, currentChapter } from './Objectives';
import { capital, cn, cnCount, cnDate, dayNumber, dueState } from './numerals';
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
type Props = {
  quest: Quest;
  store: QuestStore;
  today: string;
  scribe: ScribeLink;
  notes: NotesLink;
  onEdit(): void;
  /** 翎 proposed smaller steps for the current objective: open them on the editor's sheet. */
  onSplit(objectiveId: string, steps: ObjectiveDraft[], note?: string): void;
};

export function DetailPage({ quest, store, today, scribe, notes, onEdit, onSplit }: Props) {
  const scribeView = useScribe(scribe);
  const questNotes = useQuestNotes(notes, quest.id);
  const [splitting, setSplitting] = useState(false);
  const [splitTrouble, setSplitTrouble] = useState<string>();
  const chapter = currentChapter(quest);
  const ci = Math.min(quest.derived.chapterIndex, quest.chapters.length - 1);
  const objectives = chapter?.objectives ?? [];
  const completed = quest.status === 'completed';
  const justTracked = useJustBecame(quest.tracked);
  const justCompleted = useJustBecame(completed);
  const hiddenLater = quest.status === 'active' && objectives.filter((o) => !o.doneAt).length > 1;
  const currentObjective = quest.status === 'active' ? objectives.find((o) => !o.doneAt) : undefined;
  const split = async () => {
    if (!currentObjective || splitting) return;
    setSplitting(true);
    setSplitTrouble(undefined);
    try {
      const { objectives: steps, note } = await scribe.split(quest.id, currentObjective.id);
      onSplit(currentObjective.id, steps, note);
    } catch (cause) {
      console.error(cause);
      setSplitTrouble(scribeTrouble(cause));
    } finally {
      setSplitting(false);
    }
  };

  let kicker = quest.kind === 'main' ? '主线' : '支线';
  if (quest.kind === 'main' && chapter) kicker += ` · 第${capital(ci + 1)}章 · ${chapter.title}`;
  // A main quest's chapter may be due on its own date (design §8.2).
  const chapterDue = quest.status === 'active' ? quest.derived.chapterDeadline : undefined;
  if (quest.kind === 'main' && chapterDue) {
    const state = dueState(chapterDue, today);
    kicker += state === 'overdue' ? ' · 本章已逾期' : state === 'today' ? ' · 本章今日限期' : ` · 本章${cnDate(chapterDue)}前`;
  }
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
        {currentObjective && canAsk(scribeView) && (
          <button className={scribeStyles.split} disabled={splitting} onClick={() => void split()} title="这一步太大？请翎拆成几小步">
            {splitting ? '翎在琢磨……' : '让翎拆小'}
          </button>
        )}
      </div>
      <Objectives quest={quest} store={store} />
      {splitTrouble && <p className={scribeStyles.trouble}>{splitTrouble}</p>}
      {scribeView.present && <ScribeMargin quest={quest} scribe={scribe} />}
      {questNotes.present && <QuestNotes link={notes} questId={quest.id} notes={questNotes.notes} />}

      <Ledger quest={quest} today={today} notes={questNotes.present ? questNotes.notes.length : 0} />
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
              {c.deadline && state !== 'done' && <span className={styles.nodeDue}>{cnDate(c.deadline).replace('日', '')}前</span>}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

function Ledger({ quest, today, notes }: { quest: Quest; today: string; notes: number }) {
  const chapter = currentChapter(quest);
  const objectives = chapter?.objectives ?? [];
  const done = objectives.filter((o) => o.doneAt).length;
  const chaptersDone = quest.chapters.filter((c) => c.doneAt).length;
  const rows: [string, string][] = [];
  if (quest.kind === 'main') {
    rows.push(['本章', `${cn(done)} / ${cn(objectives.length)}`]);
    if (quest.derived.chapterDeadline && quest.status === 'active') rows.push(['本章限期', cnDate(quest.derived.chapterDeadline)]);
    rows.push(['全线', `${cn(chaptersDone)} / ${cn(quest.chapters.length)} 章`]);
  } else if (objectives.length) {
    rows.push(['目标', `${cn(done)} / ${cn(objectives.length)}`]);
  }
  if (quest.deadline && quest.status === 'active') rows.push(['限期', cnDate(quest.deadline)]);
  if (quest.attributes?.length) rows.push(['属性', quest.attributes.map(attributeName).join('、')]);
  if (notes > 0) rows.push(['手记', `${cnCount(notes)}则`]);
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

/** 翎's recent notes about this quest, and its epilogue once the quest is done. */
function ScribeMargin({ quest, scribe }: { quest: Quest; scribe: ScribeLink }) {
  const { latest } = useScribe(scribe);
  const [lines, setLines] = useState<ScribeLine[]>([]);
  const [epilogue, setEpilogue] = useState<ScribeEpilogue | null>(null);
  const completed = quest.status === 'completed';

  useEffect(() => {
    let alive = true;
    scribe.lines(quest.id).then((found) => alive && setLines(found), () => {});
    if (completed) scribe.epilogue(quest.id).then((found) => alive && setEpilogue(found), () => {});
    const stop = scribe.onEpilogue((written) => written.questId === quest.id && setEpilogue(written));
    return () => {
      alive = false;
      stop();
    };
  }, [scribe, quest.id, completed]);
  // A fresh line about this quest joins the margin as it is written.
  useEffect(() => {
    if (latest?.questId === quest.id) setLines((list) => [latest, ...list.filter((l) => l.id !== latest.id)].slice(0, 2));
  }, [latest, quest.id]);

  if (!lines.length && !epilogue) return null;
  return (
    <>
      {epilogue && (
        <div className={scribeStyles.epilogue}>
          <div className={scribeStyles.epilogueHead}>尾声</div>
          <ScribeWords line={{ id: `epilogue-${quest.id}`, text: epilogue.text, topic: 'quest', questId: quest.id, at: epilogue.writtenAt, origin: 'model' }} />
        </div>
      )}
      {!epilogue && lines.length > 0 && (
        <div className={scribeStyles.margin}>
          {[...lines].reverse().map((line) => (
            <ScribeWords key={line.id} line={line} />
          ))}
        </div>
      )}
    </>
  );
}
