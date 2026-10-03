import type { Quest, QuestKind } from '@featherlog/contracts';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  blankChapter,
  blankDraft,
  blankObjective,
  draftFromQuest,
  LIMITS,
  problem,
  toEdit,
  toInput,
  withKind,
  type ChapterRow,
  type Draft,
  type ObjectiveRow,
} from './draft';
import { InkBox, InkCheck } from './ink';
import { capital } from './numerals';
import type { QuestStore } from './store';
import styles from './editor.module.css';
import scribeStyles from './scribe.module.css';

const KINDS: { kind: QuestKind; label: string }[] = [
  { kind: 'main', label: '主线' },
  { kind: 'side', label: '支线' },
  { kind: 'daily', label: '每日委托' },
];
const KIND_LABEL: Record<QuestKind, string> = { main: '主线', side: '支线', daily: '每日委托' };
const EXAMPLE: Record<QuestKind, string> = { main: '背完 Redis 八股', side: '修好登录页', daily: '背十张卡片' };
/** Monday first, as a week is read; values are Date#getDay() (0 = Sunday). */
const WEEK = [1, 2, 3, 4, 5, 6, 0].map((day) => ({ day, label: '日一二三四五六'[day]! }));

type Props = {
  store: QuestStore;
  /** Editing this quest; absent when writing a new one. */
  quest?: Quest | undefined;
  /** The kind a new quest starts as. */
  kind: QuestKind;
  /** Saved (with the quest that was written) or put away. */
  onDone(saved?: { id: string; kind: QuestKind }): void;
  /** A proposed sheet to start from (翎's draft or split) instead of the quest as it stands. */
  seed?: Draft | undefined;
  /** What 翎 said about its proposal, shown above the sheet in its hand. */
  scribeNote?: string | undefined;
};

/**
 * The right page as a blank sheet: writing a new quest or revising one. It is
 * laid out like the quest page it produces, so what you write is where it will be read.
 */
export function Editor({ store, quest, kind, onDone, seed, scribeNote }: Props) {
  // A proposal counts as a change: putting it away asks twice, like any unsaved sheet.
  const [draft, setDraft] = useState<Draft>(() => seed ?? (quest ? draftFromQuest(quest) : blankDraft(kind)));
  const initial = useRef(seed ? '' : JSON.stringify(draft));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [confirm, setConfirm] = useState<'discard' | 'delete' | null>(null);
  const focusNext = useRef<string | null>(null);

  const issue = attempted ? problem(draft) : null;
  const dirty = JSON.stringify(draft) !== initial.current;
  const change = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setConfirm(null);
  };
  const changeChapters = (update: (chapters: ChapterRow[]) => ChapterRow[]) => {
    setDraft((d) => ({ ...d, chapters: update(d.chapters) }));
    setConfirm(null);
  };
  const changeChapter = (key: string, update: (chapter: ChapterRow) => ChapterRow) =>
    changeChapters((chapters) => chapters.map((c) => (c.key === key ? update(c) : c)));
  /** Focus lands on the row with this key when it next renders. */
  const focusRef = (key: string) => (el: HTMLInputElement | null) => {
    if (el && focusNext.current === key) {
      focusNext.current = null;
      el.focus();
    }
  };

  const save = async () => {
    setAttempted(true);
    if (problem(draft) || busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      if (quest) {
        await store.writes.save(quest.id, toEdit(quest, draft));
        onDone(quest);
      } else {
        onDone(await store.writes.create(toInput(draft)));
      }
    } catch (cause) {
      console.error(cause);
      setFailure(describe(cause));
      setBusy(false);
    }
  };
  const putAway = () => {
    if (dirty && confirm !== 'discard') setConfirm('discard');
    else onDone(quest);
  };
  const act = async (write: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await write();
      onDone();
    } catch (cause) {
      console.error(cause);
      setFailure(describe(cause));
      setBusy(false);
    }
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      // Keep Esc from reaching the shell, which would close the whole panel.
      event.stopPropagation();
      putAway();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    }
  };

  const wrong = (field: string) => (issue?.field === field ? styles.wrong : '');

  return (
    <div className={styles.editor} onKeyDown={onKey}>
      <div className={styles.sheet}>
        {scribeNote && (
          <div className={scribeStyles.draftNote}>
            <p className={scribeStyles.words}>
              {scribeNote}
              <span className={`${scribeStyles.seal} ${scribeStyles.sealOn}`} aria-hidden>
                翎
              </span>
            </p>
          </div>
        )}
        <div className={styles.kicker}>
          {quest ? (
            <span>修订 · {KIND_LABEL[quest.kind]}</span>
          ) : (
            <>
              <span>新任务</span>
              <span className={styles.kinds} role="radiogroup" aria-label="任务类型">
                {KINDS.map((k) => (
                  <button
                    key={k.kind}
                    role="radio"
                    aria-checked={draft.kind === k.kind}
                    className={draft.kind === k.kind ? styles.kindOn : ''}
                    onClick={() => change(withKind(draft, k.kind))}
                  >
                    {k.label}
                  </button>
                ))}
              </span>
            </>
          )}
        </div>

        <input
          className={`${styles.title} ${wrong('title')}`}
          value={draft.title}
          maxLength={LIMITS.title}
          placeholder="要做成的事"
          aria-label="真实目标"
          autoFocus={!quest}
          onChange={(e) => change({ title: e.target.value })}
        />
        <p className={styles.titleHint}>{draft.title ? '真实目标' : `真实目标，例如「${EXAMPLE[draft.kind]}」`}</p>

        {/* A daily is read by its goal alone; the journal never shows its name or briefing. */}
        {draft.kind !== 'daily' && (
          <>
            <label className={`${styles.line} ${wrong('name')}`}>
              <span>任务名</span>
              <input
                value={draft.name}
                maxLength={LIMITS.name}
                aria-label="任务名"
                placeholder="可不填，例如「内存之王」"
                onChange={(e) => change({ name: e.target.value })}
              />
            </label>

            <textarea
              className={`${styles.story} ${wrong('story')}`}
              value={draft.story}
              maxLength={LIMITS.story}
              rows={2}
              placeholder="写几句简报，交代来龙去脉（可不填）"
              aria-label="简报"
              onChange={(e) => change({ story: e.target.value })}
            />
          </>
        )}

        {draft.kind === 'main' && (
          <>
            <Head>章节与目标</Head>
            {draft.chapters.map((chapter, ci) => (
              <div key={chapter.key} className={`${styles.chapter} ${wrong(`chapter:${chapter.key}`)}`}>
                <div className={styles.chapterHead}>
                  <span className={styles.chapterNo}>第{capital(ci + 1)}章</span>
                  <input
                    ref={focusRef(chapter.key)}
                    value={chapter.title}
                    placeholder="章名"
                    aria-label={`第${capital(ci + 1)}章章名`}
                    onChange={(e) => changeChapter(chapter.key, (c) => ({ ...c, title: e.target.value }))}
                  />
                  {chapter.done && <small className={styles.doneTag}>已完成</small>}
                  {draft.chapters.length > 1 && (
                    <button
                      className={styles.remove}
                      title="划去这一章"
                      onClick={() => changeChapters((cs) => cs.filter((c) => c.key !== chapter.key))}
                    >
                      ×
                    </button>
                  )}
                </div>
                <ObjectiveList
                  chapter={chapter}
                  issueField={issue?.field}
                  focusRef={focusRef}
                  onFocusNext={(key) => (focusNext.current = key)}
                  onChange={(update) => changeChapter(chapter.key, update)}
                />
              </div>
            ))}
            <button
              className={styles.add}
              onClick={() => {
                const next = blankChapter();
                focusNext.current = next.key;
                changeChapters((cs) => [...cs, next]);
              }}
            >
              ＋ 再添一章
            </button>
          </>
        )}

        {draft.kind === 'side' && draft.chapters[0] && (
          <>
            <Head aside="可以一个都不写：那它就是一件事">目标</Head>
            <ObjectiveList
              chapter={draft.chapters[0]}
              issueField={issue?.field}
              focusRef={focusRef}
              onFocusNext={(key) => (focusNext.current = key)}
              onChange={(update) => changeChapter(draft.chapters[0]!.key, update)}
            />
          </>
        )}

        {draft.kind === 'daily' && (
          <>
            <Head>委托</Head>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>重复</span>
              <span className={styles.choices}>
                {(['daily', 'weekly'] as const).map((repeat) => (
                  <button key={repeat} className={draft.repeat === repeat ? styles.choiceOn : ''} onClick={() => change({ repeat })}>
                    {repeat === 'daily' ? '每天' : '每周'}
                  </button>
                ))}
              </span>
              {draft.repeat === 'weekly' && (
                <span className={`${styles.week} ${wrong('weekdays')}`}>
                  {WEEK.map(({ day, label }) => {
                    const on = draft.weekdays.includes(day);
                    return (
                      <button
                        key={day}
                        aria-pressed={on}
                        className={on ? styles.dayOn : ''}
                        onClick={() => change({ weekdays: on ? draft.weekdays.filter((d) => d !== day) : [...draft.weekdays, day] })}
                      >
                        {label}
                      </button>
                    );
                  })}
                </span>
              )}
            </div>
            <div className={`${styles.field} ${wrong('quota')}`}>
              <button
                className={styles.toggle}
                role="switch"
                aria-checked={draft.quotaOn}
                onClick={() => change({ quotaOn: !draft.quotaOn })}
              >
                <InkBox checked={draft.quotaOn} animate />
                <span>每次要做够</span>
              </button>
              {draft.quotaOn && (
                <span className={styles.count}>
                  <input
                    className={styles.number}
                    inputMode="numeric"
                    value={draft.quotaTarget}
                    placeholder="10"
                    aria-label="配额"
                    onChange={(e) => change({ quotaTarget: e.target.value })}
                  />
                  <input
                    className={styles.unit}
                    value={draft.quotaUnit}
                    placeholder="张"
                    aria-label="单位"
                    onChange={(e) => change({ quotaUnit: e.target.value })}
                  />
                </span>
              )}
            </div>
          </>
        )}

        {draft.kind !== 'daily' && (
          <div className={`${styles.field} ${styles.deadline} ${wrong('deadline')}`}>
            <span className={styles.fieldLabel}>限期</span>
            <input type="date" value={draft.deadline} aria-label="限期" onChange={(e) => change({ deadline: e.target.value })} />
            {draft.deadline ? (
              <button className={styles.quiet} onClick={() => change({ deadline: '' })}>
                不设限期
              </button>
            ) : (
              <span className={styles.quietText}>不设限期</span>
            )}
          </div>
        )}
      </div>

      <footer className={styles.foot}>
        {(issue || failure) && <p className={styles.problem}>{issue?.message ?? failure}</p>}
        <div className={styles.actions}>
          {quest && (
            <span className={styles.danger}>
              {quest.status === 'active' && (
                <button disabled={busy} onClick={() => void act(() => store.writes.archive(quest.id))} title="收进箱底，不再出现在日志里">
                  归档
                </button>
              )}
              <button
                disabled={busy}
                className={confirm === 'delete' ? styles.confirming : ''}
                onClick={() => (confirm === 'delete' ? void act(() => store.writes.remove(quest.id)) : setConfirm('delete'))}
              >
                {confirm === 'delete' ? '再点一次，撕掉这一页' : '删除'}
              </button>
            </span>
          )}
          <button className={`${styles.cancel} ${confirm === 'discard' ? styles.confirming : ''}`} onClick={putAway}>
            {confirm === 'discard' ? '再点一次，不留改动' : '作罢'}
          </button>
          <button className={styles.save} disabled={busy} onClick={() => void save()} title="Ctrl + Enter">
            落笔
          </button>
        </div>
      </footer>
    </div>
  );
}

function Head({ children, aside }: { children: ReactNode; aside?: string }) {
  return (
    <div className={styles.head}>
      <span>{children}</span>
      {aside && <small>{aside}</small>}
    </div>
  );
}

type ListProps = {
  chapter: ChapterRow;
  issueField: string | undefined;
  focusRef(key: string): (el: HTMLInputElement | null) => void;
  onFocusNext(key: string): void;
  onChange(update: (chapter: ChapterRow) => ChapterRow): void;
};

/** One chapter's objectives. Enter starts the next line; Backspace on an empty line takes it away. */
function ObjectiveList({ chapter, issueField, focusRef, onFocusNext, onChange }: ListProps) {
  const set = (key: string, patch: Partial<ObjectiveRow>) =>
    onChange((c) => ({ ...c, objectives: c.objectives.map((o) => (o.key === key ? { ...o, ...patch } : o)) }));
  const insertAfter = (index: number) => {
    const next = blankObjective();
    onFocusNext(next.key);
    onChange((c) => ({ ...c, objectives: [...c.objectives.slice(0, index + 1), next, ...c.objectives.slice(index + 1)] }));
  };
  const removeAt = (index: number, focusPrevious: boolean) => {
    const previous = chapter.objectives[index - 1];
    if (focusPrevious && previous) onFocusNext(previous.key);
    onChange((c) => ({ ...c, objectives: c.objectives.filter((_, i) => i !== index) }));
  };

  return (
    <ol className={styles.objectives}>
      {chapter.objectives.map((o, i) => (
        <li key={o.key} className={`${styles.objective} ${issueField === `objective:${o.key}` ? styles.wrong : ''}`}>
          <span className={styles.bullet}>{o.done ? <InkCheck className={styles.doneMark} /> : <i />}</span>
          <input
            ref={focusRef(o.key)}
            className={styles.objectiveText}
            value={o.text}
            placeholder={i === 0 ? '写下一个目标' : '下一个目标'}
            aria-label={`目标 ${i + 1}`}
            onChange={(e) => set(o.key, { text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                insertAfter(i);
              } else if (e.key === 'Backspace' && o.text === '' && chapter.objectives.length > 1) {
                e.preventDefault();
                removeAt(i, true);
              }
            }}
          />
          {o.counted ? (
            <span className={styles.count}>
              <span>共</span>
              <input
                className={styles.number}
                inputMode="numeric"
                value={o.target}
                placeholder="30"
                aria-label="计数目标"
                onChange={(e) => set(o.key, { target: e.target.value })}
              />
              <input
                className={styles.unit}
                value={o.unit}
                placeholder="张"
                aria-label="单位"
                onChange={(e) => set(o.key, { unit: e.target.value })}
              />
              <button className={styles.countToggle} onClick={() => set(o.key, { counted: false })}>
                不计
              </button>
            </span>
          ) : (
            <button className={styles.countToggle} onClick={() => set(o.key, { counted: true })} title="例如：背 30 张卡片">
              计数
            </button>
          )}
          {chapter.objectives.length > 1 && (
            <button className={`${styles.remove} ${styles.rowRemove}`} title="划去" onClick={() => removeAt(i, false)}>
              ×
            </button>
          )}
        </li>
      ))}
      <li>
        <button className={styles.add} onClick={() => insertAfter(chapter.objectives.length - 1)}>
          ＋ 添一个目标
        </button>
      </li>
    </ol>
  );
}

function describe(cause: unknown): string {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  const message = cause instanceof Error ? cause.message : '';
  if (code === 'quest/invalid-input') return `有一处不合规矩：${message}`;
  if (code === 'quest/not-found') return '这个任务已经不在日志里了';
  return '没能落笔，请再试一次';
}
