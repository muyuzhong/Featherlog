import type { Quest, ScribeBoard, ScribeRecap, ScribeState, UiBus, UiSound } from '@featherlog/contracts';
import { useCallback, useEffect, useState } from 'react';
import styles from './scribe-book.module.css';

/** A model call can take up to 30 s, with one retry (design §14.4). */
const MODEL_TIMEOUT_MS = 65_000;

const DIGITS = '〇一二三四五六七八九';
const cn = (n: number) =>
  n < 10 ? DIGITS[n]! : n < 20 ? `十${n % 10 ? DIGITS[n % 10] : ''}` : `${DIGITS[Math.floor(n / 10)]}十${n % 10 ? DIGITS[n % 10] : ''}`;
/** "2026-10-03" → 十月三日 */
const cnDate = (localDate: string) => {
  const [, month, day] = localDate.slice(0, 10).split('-').map(Number);
  return `${cn(month!)}月${cn(day!)}日`;
};

function trouble(cause: unknown): string {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  if (code === 'scribe/not-configured') return '还没配置好接口';
  if (code === 'scribe/no-consent') return '还没同意告知';
  if (code === 'scribe/auth-failed') return '接口拒绝了这把钥匙';
  if (code === 'scribe/unavailable') return '一时联系不上接口，过会儿再试';
  if (code === 'scribe/unusable-reply') return '翎没写成，过会儿再试';
  return '没能办到，过会儿再试';
}

type Props = { bus: UiBus; sound: UiSound };

/** The 札记 tab (design §14.6): where 翎 stands, today's first moves, and the recaps. */
export function ScribeBook({ bus, sound }: Props) {
  const [state, setState] = useState<ScribeState | null>(null);
  const [board, setBoard] = useState<ScribeBoard | null>(null);
  const [quests, setQuests] = useState<Quest[]>([]);
  const [today, setToday] = useState<ScribeRecap | null>(null);
  const [past, setPast] = useState<ScribeRecap[]>([]);

  const loadRecaps = useCallback(() => {
    bus.request('scribe/recap', {}).then(({ recap }) => setToday(recap), () => {});
    bus.request('scribe/recaps', { limit: 12 }).then(({ recaps }) => setPast(recaps), () => {});
  }, [bus]);

  useEffect(() => {
    bus.request('scribe/state', {}).then(setState, (cause) => console.error('scribe/state failed', cause));
    bus.request('quest/list', {}).then(({ quests }) => setQuests(quests), () => {});
    loadRecaps();
    const stops = [
      bus.on('scribe/state-changed', ({ state }) => setState(state)),
      bus.on('scribe/recap-written', () => loadRecaps()),
    ];
    return () => stops.forEach((stop) => stop());
  }, [bus, loadRecaps]);

  const ready = !!state && state.enabled && state.consented && state.configured && !state.paused;
  useEffect(() => {
    if (!state?.enabled) return;
    bus.request('scribe/board', {}, { timeoutMs: MODEL_TIMEOUT_MS }).then(setBoard, () => {});
  }, [bus, state?.enabled, ready]);

  return (
    <div className={styles.book}>
      <div className={styles.pageWrap}>
        <section className={`${styles.page} ${styles.left} fl-paper`}>
          <header className={styles.head}>
            <h1>翎的札记</h1>
            <p>替你执笔的那支翎羽，在这里落款</p>
          </header>
          <Standing bus={bus} sound={sound} state={state} />
          {state?.enabled && (
            <Board
              board={board}
              quests={quests}
              onOpen={(questId) =>
                void bus.request('shell/open-panel', { tab: 'quest/journal', params: { questId } }).catch(console.error)
              }
            />
          )}
        </section>
      </div>
      <div className={styles.pageWrap}>
        <section className={`${styles.page} ${styles.right} fl-paper`}>
          <Recaps bus={bus} sound={sound} ready={ready} today={today} past={past} onWritten={loadRecaps} />
        </section>
      </div>
      <div className={styles.gutter} />
    </div>
  );
}

function openSettings(bus: UiBus) {
  void bus.request('shell/open-panel', { tab: 'shell/settings' }).catch(console.error);
}

/** Where 翎 stands, and the one thing that would move it forward. */
function Standing({ bus, sound, state }: { bus: UiBus; sound: UiSound; state: ScribeState | null }) {
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<string>();
  const consent = async (granted: boolean) => {
    setBusy(true);
    try {
      await bus.request('scribe/consent', { granted });
      sound.play(granted ? 'seal' : 'erase');
    } catch (cause) {
      console.error(cause);
    } finally {
      setBusy(false);
    }
  };
  const tryIt = async () => {
    setBusy(true);
    setTest('翎在试笔……');
    try {
      const result = await bus.request('scribe/test', {}, { timeoutMs: MODEL_TIMEOUT_MS });
      if (result.ok) {
        sound.play('unlock');
        setTest(`通了 · ${result.model} · ${(result.ms / 1000).toFixed(1)} 秒`);
      } else setTest(`没通：${result.message}`);
    } catch (cause) {
      setTest(`没通：${trouble(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <p className={styles.quiet}>……</p>;
  if (!state.enabled)
    return (
      <div className={styles.card}>
        <p className={styles.say}>翎还在歇着。请它执笔之后，它会回应你的每一笔，帮你起草任务、拆小难关、写今日战报。</p>
        <button className={styles.inkButton} onClick={() => openSettings(bus)}>
          去设置里请翎执笔
        </button>
      </div>
    );
  if (!state.consented)
    return (
      <div className={`${styles.card} ${styles.notice}`}>
        <h2>执笔之前</h2>
        <p>
          翎会把下面这些内容发送给你配置的接口
          <b>{state.endpoint ? ` ${state.endpoint} ` : '（还没填写接口地址）'}</b>
          来写回应：
        </p>
        <ul>
          <li>任务的标题、任务名、简报、章节与目标</li>
          <li>最近的进展：完成了哪些目标、连续了几天</li>
          <li>你对翎说的话</li>
        </ul>
        <p>
          不会发送随笔；手记只有在设置里打开"让翎读我的手记"后才会发送。翎说过的话、战报和尾声只存在这台电脑上。随时可以在这里撤回同意。
        </p>
        <div className={styles.actions}>
          <button className={styles.inkButton} disabled={busy} onClick={() => void consent(true)}>
            同意，请翎执笔
          </button>
          <button className={styles.quietButton} disabled={busy} onClick={() => openSettings(bus)}>
            先去看看设置
          </button>
        </div>
      </div>
    );
  if (state.paused)
    return (
      <div className={styles.card}>
        <p className={`${styles.say} ${styles.warn}`}>翎停笔了：{state.paused.message}</p>
        <button className={styles.inkButton} onClick={() => openSettings(bus)}>
          去设置里看看
        </button>
      </div>
    );
  if (!state.configured)
    return (
      <div className={styles.card}>
        <p className={styles.say}>还差一点：在设置里填好接口协议、地址和模型；远程接口还需要 API Key。</p>
        <button className={styles.inkButton} onClick={() => openSettings(bus)}>
          去设置里填写
        </button>
      </div>
    );

  const { usage } = state;
  return (
    <div className={styles.card}>
      <p className={styles.say}>
        翎已执笔<span className={styles.endpoint}>{state.endpoint}</span>
      </p>
      <div className={styles.actions}>
        <button className={styles.inkButton} disabled={busy} onClick={() => void tryIt()}>
          试一试
        </button>
        {test && <span className={styles.test}>{test}</span>}
      </div>
      <p className={styles.usage}>
        本月 {usage.calls} 次 · 输入 {usage.inputTokens.toLocaleString()} · 输出 {usage.outputTokens.toLocaleString()} tokens
        {usage.unreported > 0 && ` · ${usage.unreported} 次接口未报用量`}
      </p>
      <button className={styles.withdraw} disabled={busy} onClick={() => void consent(false)}>
        撤回同意
      </button>
    </div>
  );
}

function Board({ board, quests, onOpen }: { board: ScribeBoard | null; quests: Quest[]; onOpen(questId: string): void }) {
  if (!board) return null;
  const byId = new Map(quests.map((q) => [q.id, q]));
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>今日先做</h2>
      {board.items.length === 0 ? (
        <p className={styles.quiet}>今天没有急事。挑一件喜欢的，慢慢来。</p>
      ) : (
        <ol className={styles.board}>
          {board.items.map((item) => {
            const quest = byId.get(item.questId);
            const objective = item.objectiveId
              ? quest?.chapters.flatMap((c) => c.objectives).find((o) => o.id === item.objectiveId)
              : undefined;
            return (
              <li key={`${item.questId}-${item.objectiveId ?? ''}`}>
                <button onClick={() => onOpen(item.questId)}>
                  <span className={styles.boardName}>{quest ? (quest.name ?? quest.title) : '（一个任务）'}</span>
                  {objective && <span className={styles.boardObjective}>{objective.text}</span>}
                  <span className={styles.boardReason}>{item.reason}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

type RecapProps = {
  bus: UiBus;
  sound: UiSound;
  ready: boolean;
  today: ScribeRecap | null;
  past: ScribeRecap[];
  onWritten(): void;
};

function Recaps({ bus, sound, ready, today, past, onWritten }: RecapProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const write = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      await bus.request('scribe/recap', { write: true }, { timeoutMs: MODEL_TIMEOUT_MS });
      sound.play('page');
      onWritten();
    } catch (cause) {
      console.error(cause);
      setProblem(trouble(cause));
    } finally {
      setBusy(false);
    }
  };
  const earlier = past.filter((r) => r.periodKey !== today?.periodKey);
  return (
    <div className={styles.recaps}>
      <h2 className={styles.recapTitle}>今日战报</h2>
      {today ? (
        <p className={styles.recapText}>{today.text}</p>
      ) : (
        <div className={styles.recapEmpty}>
          <p className={styles.quiet}>今天的战报还没写。到了设定的时辰，翎会在你打开日志时写下。</p>
          {ready && (
            <button className={styles.inkButton} disabled={busy} onClick={() => void write()}>
              {busy ? '翎在写……' : '请翎现在写'}
            </button>
          )}
          {problem && <p className={styles.warn}>{problem}</p>}
        </div>
      )}
      {earlier.length > 0 && (
        <>
          <h2 className={styles.sectionTitle}>往日</h2>
          <div className={styles.past}>
            {earlier.map((recap) => (
              <article key={recap.periodKey}>
                <h3>{cnDate(recap.periodKey)}</h3>
                <p>{recap.text}</p>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
