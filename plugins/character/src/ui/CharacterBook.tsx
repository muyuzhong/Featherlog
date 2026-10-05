import type { AttributeStanding, CharacterTitle, ChronicleEntry, PanelTabHost, QuestAttribute } from '@featherlog/contracts';
import { useEffect, useState } from 'react';
import { useCharacter, type CharacterStore } from './store';
import styles from './character.module.css';

const ATTRIBUTE: Record<QuestAttribute, { name: string; seal: string }> = {
  learning: { name: '学识', seal: '学' },
  body: { name: '体魄', seal: '体' },
  mind: { name: '心性', seal: '心' },
  craft: { name: '技艺', seal: '技' },
};

const DIGITS = '〇一二三四五六七八九';
const cn = (n: number) =>
  n < 10 ? DIGITS[n]! : n < 20 ? `十${n % 10 ? DIGITS[n % 10] : ''}` : `${DIGITS[Math.floor(n / 10)]}十${n % 10 ? DIGITS[n % 10] : ''}`;
const cnYear = (n: number) => [...String(n)].map((d) => DIGITS[Number(d)]).join('');
const monthOf = (iso: string) => {
  const d = new Date(iso);
  return `${cnYear(d.getFullYear())}年${cn(d.getMonth() + 1)}月`;
};
const dayOf = (iso: string) => {
  const d = new Date(iso);
  return `${cn(d.getMonth() + 1)}月${cn(d.getDate())}日`;
};

const SEEN_KEY = 'featherlog.character.seen';

/**
 * When the page was last looked at, as of this opening (design §16.5): what came
 * after it gets a small vermilion dot until the next time. Losing it is harmless.
 */
function useSince(host: PanelTabHost): string | null {
  const [since, setSince] = useState<string | null>(null);
  useEffect(() => {
    const look = () => {
      let previous: string | null = null;
      try {
        previous = localStorage.getItem(SEEN_KEY);
        localStorage.setItem(SEEN_KEY, new Date().toISOString());
      } catch {
        // Without storage every visit is the first; nothing is marked new.
      }
      setSince(previous);
    };
    if (host.visible) look();
    return host.onShow(look);
  }, [host]);
  return since;
}

/** The 角色 tab (design §16.7): the person on the left page, the chronicle on the right. */
export function CharacterBook({ store, host }: { store: CharacterStore; host: PanelTabHost }) {
  const { sheet, chronicle, more, epilogues } = useCharacter(store);
  const since = useSince(host);
  const fresh = (at: string | undefined) => !!at && !!since && at > since;
  const freshRank = (attribute: QuestAttribute) =>
    chronicle.some((e) => e.kind === 'rank' && e.attribute === attribute && fresh(e.at));

  return (
    <div className={styles.book}>
      <div className={styles.pageWrap}>
        <section className={`${styles.page} ${styles.left} fl-paper`}>
          {sheet && (
            <>
              <Person titles={sheet.titles} worn={sheet.worn} />
              <div className={styles.attributes}>
                {sheet.attributes.map((standing) => (
                  <Attribute key={standing.attribute} standing={standing} fresh={freshRank(standing.attribute)} />
                ))}
              </div>
              {sheet.unassigned > 0 && (
                <p className={styles.unassigned}>另有 {sheet.unassigned} 历练尚未归入属性：在任务的修订里选一选</p>
              )}
              <Titles
                titles={sheet.titles}
                worn={sheet.worn}
                fresh={(title) => fresh(title.earnedAt)}
                onWear={(id) => void store.wear(id).catch(console.error)}
              />
            </>
          )}
        </section>
      </div>
      <div className={styles.pageWrap}>
        <section className={`${styles.page} ${styles.right} fl-paper`}>
          <header className={styles.head}>
            <h1>编年</h1>
            <p>一路走来，都记在这里</p>
          </header>
          <Chronicle
            entries={chronicle}
            more={more}
            epilogues={epilogues}
            fresh={(entry) => fresh(entry.at) && (entry.kind === 'rank' || entry.kind === 'title')}
            onEpilogue={store.epilogue}
            onOpen={store.openQuest}
            onMore={() => void store.loadMore().catch(console.error)}
          />
        </section>
      </div>
      <div className={styles.gutter} />
    </div>
  );
}

function Person({ titles, worn }: { titles: CharacterTitle[]; worn: string | null }) {
  const title = titles.find((t) => t.id === worn);
  return (
    <header className={styles.person}>
      <p className={styles.kicker}>人物</p>
      <h1 className={title ? '' : styles.nameless}>{title?.name ?? '无名冒险者'}</h1>
      <p className={styles.personNote}>{title ? title.hint : '得了称号，就可以佩戴一个'}</p>
    </header>
  );
}

function Attribute({ standing, fresh }: { standing: AttributeStanding; fresh: boolean }) {
  const { attribute, points, rank, rankName, rankFrom, nextAt } = standing;
  const { name, seal } = ATTRIBUTE[attribute];
  const share = nextAt === undefined ? 1 : (points - rankFrom) / (nextAt - rankFrom);
  return (
    <div className={styles.attribute} title={nextAt === undefined ? `历练 ${points} · 已至化境` : `历练 ${points} / ${nextAt}`}>
      <span className={`${styles.seal} ${rank > 0 ? styles.sealOn : ''}`}>{seal}</span>
      <div className={styles.attributeBody}>
        <div className={styles.attributeLine}>
          <span className={styles.attributeName}>{name}</span>
          <span className={rank > 0 ? styles.rank : styles.rankNone}>{rankName}</span>
          {fresh && <i className={styles.dot} aria-label="新" />}
          <span className={styles.points}>{nextAt === undefined ? points : `${points} / ${nextAt}`}</span>
        </div>
        <div className={styles.bar} role="progressbar" aria-label={`${name}·${rankName}`} aria-valuenow={Math.round(share * 100)}>
          <span style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

type TitlesProps = {
  titles: CharacterTitle[];
  worn: string | null;
  fresh(title: CharacterTitle): boolean;
  onWear(id: string | null): void;
};

function Titles({ titles, worn, fresh, onWear }: TitlesProps) {
  // Inscribed titles first, then the fixed ones; earned before unearned, each in its own order.
  const earned = titles.filter((t) => t.earnedAt).sort((a, b) => Number(!a.questId) - Number(!b.questId));
  const locked = titles.filter((t) => !t.earnedAt);
  return (
    <section className={styles.titlesSection}>
      <h2 className={styles.sectionTitle}>
        称号<small>已得 {cn(earned.length)} 个</small>
      </h2>
      <div className={styles.titles}>
        {earned.map((title) => {
          const on = title.id === worn;
          return (
            <button
              key={title.id}
              className={`${styles.title} ${on ? styles.titleWorn : ''} ${title.questId ? styles.titleGift : ''}`}
              aria-pressed={on}
              title={on ? '再点一次，摘下' : `${title.hint} · 点一下佩戴`}
              onClick={() => onWear(on ? null : title.id)}
            >
              <span className={styles.titleName}>{title.name}</span>
              <span className={styles.titleHint}>{title.hint}</span>
              {on && <span className={styles.worn}>佩</span>}
              {fresh(title) && !on && <i className={styles.dot} aria-label="新" />}
            </button>
          );
        })}
        {locked.map((title) => (
          <div key={title.id} className={styles.locked}>
            <span className={styles.titleName}>{title.name}</span>
            <span className={styles.titleHint}>{title.hint}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

type ChronicleProps = {
  entries: ChronicleEntry[];
  more: boolean;
  epilogues: Map<string, string | null>;
  fresh(entry: ChronicleEntry): boolean;
  onEpilogue(questId: string): void;
  onOpen(questId: string): void;
  onMore(): void;
};

function Chronicle({ entries, more, epilogues, fresh, onEpilogue, onOpen, onMore }: ChronicleProps) {
  useEffect(() => {
    for (const e of entries) if (e.kind === 'quest-completed' && e.questKind === 'main') onEpilogue(e.questId);
  }, [entries, onEpilogue]);

  if (!entries.length) return <p className={styles.empty}>完成一条支线、主线的一章，这里就落下第一笔。</p>;

  const months: { month: string; entries: ChronicleEntry[] }[] = [];
  for (const entry of entries) {
    const month = monthOf(entry.at);
    if (months.at(-1)?.month === month) months.at(-1)!.entries.push(entry);
    else months.push({ month, entries: [entry] });
  }
  return (
    <div className={styles.chronicle}>
      {months.map(({ month, entries: list }) => (
        <section key={month}>
          <h2 className={styles.month}>{month}</h2>
          <ol className={styles.entries}>
            {list.map((entry) => (
              <li key={entry.id} className={`${styles.entry} ${entry.kind === 'rank' || entry.kind === 'title' ? styles.milestone : ''}`}>
                <span className={styles.day}>{dayOf(entry.at)}</span>
                <span className={styles.what}>
                  <Line entry={entry} onOpen={onOpen} />
                  {fresh(entry) && <i className={styles.dot} aria-label="新" />}
                  {entry.kind === 'quest-completed' && epilogues.get(entry.questId) && (
                    <span className={styles.epilogue}>{epilogues.get(entry.questId)}</span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}
      {more && (
        <button className={styles.more} onClick={onMore}>
          更早的……
        </button>
      )}
    </div>
  );
}

function Line({ entry, onOpen }: { entry: ChronicleEntry; onOpen(questId: string): void }) {
  const quest = (questId: string, label: string) => (
    <button className={styles.questLink} onClick={() => onOpen(questId)}>
      「{label}」
    </button>
  );
  switch (entry.kind) {
    case 'quest-completed':
      return (
        <>
          {quest(entry.questId, entry.label)}
          {entry.questKind === 'main' ? '卷终' : '了却'}
        </>
      );
    case 'chapter-completed':
      return (
        <>
          {quest(entry.questId, entry.label)}
          {entry.chapterTitle}一章告成
        </>
      );
    case 'rank':
      return (
        <>
          <b>{ATTRIBUTE[entry.attribute].name} · {entry.rankName}</b>
        </>
      );
    case 'title':
      return (
        <>
          得称号<b>「{entry.titleName}」</b>
        </>
      );
  }
}
