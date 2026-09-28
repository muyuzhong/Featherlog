import type { Quest, QuestKind } from '@featherlog/contracts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { InkBox, InkRule, InkStrike, Quill } from './ink';
import { currentChapter } from './Objectives';
import { capital, cn, cnCount, cnDate } from './numerals';
import type { QuestStore } from './store';
import styles from './journal.module.css';

type Props = {
  quests: Quest[];
  selectedId: string | undefined;
  today: string;
  day: number;
  store: QuestStore;
  onSelect(id: string): void;
  onCreate(kind: QuestKind): void;
  onEdit(id: string): void;
};

/** The left page: the journal's index of quests. */
export function ListPage({ quests, selectedId, today, day, store, onSelect, onCreate, onEdit }: Props) {
  const [showDone, setShowDone] = useState(false);
  const active = quests.filter((q) => q.status === 'active');
  const mains = active.filter((q) => q.kind === 'main');
  const sides = active.filter((q) => q.kind === 'side');
  const dailies = active.filter((q) => q.kind === 'daily');
  const finished = quests
    .filter((q) => q.status === 'completed' && q.kind !== 'daily')
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  const dailiesDone = dailies.filter((d) => d.cycle?.done).length;

  const entry = (q: Quest) => <Entry key={q.id} quest={q} selected={q.id === selectedId} onSelect={() => onSelect(q.id)} />;

  return (
    <div className={styles.listPage}>
      <header className={styles.listHead}>
        <h1 className="fl-ink-bleed">任务日志</h1>
        <p>
          {cnDate(today)} <span>·</span> 启程第{cn(day)}日
        </p>
      </header>
      <InkRule className={styles.headRule} />

      <Section title="主线" onAdd={() => onCreate('main')} aside={mains.length ? `${cnCount(mains.length)}卷` : undefined}>
        {mains.length ? mains.map(entry) : <p className={styles.empty}>尚无主线</p>}
      </Section>

      <Section title="支线" onAdd={() => onCreate('side')} aside={sides.length ? `${cnCount(sides.length)}件` : undefined}>
        {sides.length ? sides.map(entry) : <p className={styles.empty}>眼下没有支线</p>}
      </Section>

      <Section
        title="每日委托"
        onAdd={() => onCreate('daily')}
        aside={dailies.length ? `${cn(dailiesDone)} / ${cn(dailies.length)}` : undefined}
      >
        <div className={styles.dailies}>
          {dailies.map((d) => (
            <Daily key={d.id} quest={d} store={store} onEdit={() => onEdit(d.id)} />
          ))}
        </div>
      </Section>

      <footer className={styles.listFoot}>
        {finished.length > 0 && (
          <button className={styles.doneToggle} onClick={() => setShowDone(!showDone)}>
            {showDone ? '合上卷末' : `卷末 · 已完成的任务${cnCount(finished.length)}件`}
          </button>
        )}
        {showDone && (
          <div className={styles.finished}>
            {finished.map((q) => (
              <button key={q.id} className={q.id === selectedId ? styles.finishedOn : ''} onClick={() => onSelect(q.id)}>
                <span>{q.name ?? q.title}</span>
                <small>{q.completedAt ? cnDate(q.completedAt) : ''}</small>
              </button>
            ))}
          </div>
        )}
        <div className={styles.folio}>— {cn(day)} —</div>
      </footer>
    </div>
  );
}

type SectionProps = {
  title: string;
  aside?: string | undefined;
  onAdd(): void;
  children: ReactNode;
};

function Section({ title, aside, onAdd, children }: SectionProps) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>
        <span>{title}</span>
        {aside && <small>{aside}</small>}
        <button className={styles.addQuest} onClick={onAdd} title={`新的${title}`}>
          添一笔
        </button>
      </h2>
      {children}
    </section>
  );
}

function Entry({ quest, selected, onSelect }: { quest: Quest; selected: boolean; onSelect(): void }) {
  const chapter = currentChapter(quest);
  const objectives = chapter?.objectives ?? [];
  const done = objectives.filter((o) => o.doneAt).length;

  let sub = quest.name ? quest.title : '';
  let meta: ReactNode = objectives.length ? `${cn(done)} / ${cn(objectives.length)}` : '';
  if (quest.kind === 'main' && chapter) sub = `第${capital(quest.derived.chapterIndex + 1)}章 · ${chapter.title}`;
  if (quest.kind === 'side') {
    if (quest.derived.overdue) meta = <em>已逾期</em>;
    else if (quest.derived.dueToday && quest.deadline) meta = <em>今日限期</em>;
    else if (quest.deadline) meta = cnDate(quest.deadline).replace('日', '') + '前';
  }

  return (
    <button className={`${styles.entry} ${selected ? styles.entryOn : ''}`} onClick={onSelect}>
      <span className={styles.entryMark}>{quest.tracked && <Quill />}</span>
      <span className={styles.entryBody}>
        <span className={styles.entryName}>{quest.name ?? quest.title}</span>
        {sub && <span className={styles.entrySub}>{sub}</span>}
      </span>
      <span className={styles.entryMeta}>{meta}</span>
    </button>
  );
}

function Daily({ quest, store, onEdit }: { quest: Quest; store: QuestStore; onEdit(): void }) {
  const done = quest.cycle?.done ?? false;
  const wasDone = useRef(done);
  const fresh = done && !wasDone.current;
  useEffect(() => {
    wasDone.current = done;
  }, [done]);

  const act = () => {
    if (done) store.actions.uncomplete(quest.id);
    else if (quest.quota) store.actions.count(quest.id);
    else store.actions.complete(quest.id);
  };
  return (
    <div className={styles.dailyRow}>
      <button
        className={`${styles.daily} ${done ? styles.dailyDone : ''}`}
        onClick={act}
        title={done ? '撤回' : quest.quota ? '记一次' : '完成'}
      >
        <InkBox checked={done} animate={fresh} />
        <span className={styles.dailyBody}>
          <span className={styles.dailyName}>
            {quest.title}
            {done && <InkStrike animate={fresh} />}
          </span>
          <span className={styles.dailySub}>
            {quest.quota && !done
              ? `${cn(quest.cycle?.current ?? 0)} / ${cn(quest.quota.target)}`
              : quest.derived.streak > 1
                ? `已连续${cnCount(quest.derived.streak)}日`
                : ''}
          </span>
        </span>
      </button>
      <button className={styles.dailyEdit} onClick={onEdit} title="修订这项委托">
        改
      </button>
    </div>
  );
}
