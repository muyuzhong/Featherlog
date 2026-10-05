import type { Flashcard } from '@featherlog/contracts';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useFlashcards, type FlashcardsStore } from './store';
import styles from './deck.module.css';

/** Field limits of design §17.3, checked here so the main half's rejection is a backstop. */
const LIMITS = { deck: 40, question: 500, answer: 10000 };
const MAX_FILE = 1024 * 1024;

type Page = { kind: 'card'; id: string } | { kind: 'new' } | { kind: 'import'; result?: string } | { kind: 'blank' };

const DIGITS = '〇一二三四五六七八九';
const cn = (n: number) =>
  n < 10 ? DIGITS[n]! : n < 20 ? `十${n % 10 ? DIGITS[n % 10] : ''}` : `${DIGITS[Math.floor(n / 10)]}十${n % 10 ? DIGITS[n % 10] : ''}`;
const cnDay = (iso: string) => {
  const d = new Date(iso);
  return `${cn(d.getMonth() + 1)}月${cn(d.getDate())}日`;
};
const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '';

/** The 八股 tab (design §17.5): decks and cards on the left, one card or an import on the right. */
export function DeckBook({ store }: { store: FlashcardsStore }) {
  const { cards, decks, filter } = useFlashcards(store);
  const [page, setPage] = useState<Page>({ kind: 'blank' });
  const [query, setQuery] = useState(filter.query);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => query !== filter.query && store.setFilter({ query }), 300);
    return () => window.clearTimeout(timer);
  }, [query, filter.query, store]);

  const selected = page.kind === 'card' ? cards.find((c) => c.id === page.id) : undefined;
  // The open card was deleted (here or in another window), or filtered away.
  useEffect(() => {
    if (page.kind === 'card' && !selected) setPage({ kind: 'blank' });
  }, [page, selected]);

  const total = decks.reduce((sum, d) => sum + d.total, 0);
  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    if (chosen.size > MAX_FILE) return setPage({ kind: 'import', result: '文件超过 1 MB，没有导入' });
    try {
      // The main half never touches files (AGENTS.md rule 6): the window reads it and sends the text.
      const { created, skipped } = await store.import(await chosen.text(), chosen.name.replace(/\.[^.]+$/, ''));
      setPage({ kind: 'import', result: imported(created, skipped) });
    } catch (cause) {
      console.error(cause);
      setPage({ kind: 'import', result: '没能导入：文件内容不合格式，或超过了 1 MB' });
    }
  };

  return (
    <div className={styles.book}>
      <div className={styles.pageWrap}>
        <section className={`${styles.page} ${styles.left} fl-paper`}>
          <header className={styles.head}>
            <h1>八股</h1>
            <p>等待的空档，背上一题</p>
          </header>
          <div className={styles.tools}>
            <button onClick={() => setPage({ kind: 'new' })}>＋ 添一题</button>
            <button onClick={() => setPage({ kind: 'import' })}>粘贴导入</button>
            <button onClick={() => file.current?.click()}>导入文件</button>
            <input ref={file} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={(e) => void onFile(e)} />
          </div>
          <div className={styles.decks} role="radiogroup" aria-label="题组">
            <button role="radio" aria-checked={filter.deck === undefined} className={filter.deck === undefined ? styles.deckOn : ''} onClick={() => store.setFilter({ deck: undefined })}>
              全部<small>{total}</small>
            </button>
            {decks.map((deck) => (
              <button
                key={deck.name}
                role="radio"
                aria-checked={filter.deck === deck.name}
                className={filter.deck === deck.name ? styles.deckOn : ''}
                title={`共 ${deck.total} 题 · 今日到期 ${deck.due} · 新题 ${deck.fresh}`}
                onClick={() => store.setFilter({ deck: deck.name })}
              >
                {deck.name || '未分组'}
                <small>
                  {deck.total}
                  {deck.due > 0 && <em> · 到期 {deck.due}</em>}
                </small>
              </button>
            ))}
          </div>
          <input className={styles.search} value={query} placeholder="翻找……" aria-label="搜索八股" onChange={(e) => setQuery(e.target.value)} />
          <ol className={styles.list}>
            {cards.map((card) => (
              <li key={card.id}>
                <button className={card.id === selected?.id ? styles.entryOn : ''} onClick={() => setPage({ kind: 'card', id: card.id })}>
                  <span className={styles.entryText}>{firstLine(card.question)}</span>
                  <Mastery card={card} />
                </button>
              </li>
            ))}
          </ol>
          {cards.length === 0 && (
            <p className={styles.empty}>{filter.query ? '没有翻到这样的题。' : '还没有题。添一题，或者把整理好的八股粘贴进来。'}</p>
          )}
        </section>
      </div>
      <div className={styles.pageWrap}>
        <section className={`${styles.page} ${styles.right} fl-paper`}>
          {page.kind === 'new' && (
            <CardSheet
              key="new"
              store={store}
              deck={filter.deck ?? ''}
              decks={decks.map((d) => d.name)}
              onSaved={(card) => setPage({ kind: 'card', id: card.id })}
            />
          )}
          {page.kind === 'card' && selected && (
            <CardSheet key={selected.id} store={store} card={selected} decks={decks.map((d) => d.name)} onDeleted={() => setPage({ kind: 'blank' })} />
          )}
          {page.kind === 'import' && (
            <ImportSheet store={store} deck={filter.deck ?? ''} result={page.result} onResult={(result) => setPage({ kind: 'import', result })} />
          )}
          {page.kind === 'blank' && (
            <div className={styles.blank}>
              <p>选一题来看看，或者添一题。</p>
              <p className={styles.blankHint}>平时把鼠标移到卷轴上的这个图标，就能背一题。</p>
            </div>
          )}
        </section>
      </div>
      <div className={styles.gutter} />
    </div>
  );
}

const imported = (created: number, skipped: number) =>
  created || skipped ? `导入 ${created} 题${skipped ? `，跳过 ${skipped} 题（重复、没有答案或太长）` : ''}` : '没有找到题目：问题要写成 ## 标题';

/** How settled a card is: one dot per box (design §17.4), hollow for a new card. */
function Mastery({ card }: { card: Flashcard }) {
  if (card.review.due === undefined) return <span className={styles.newMark}>新</span>;
  return (
    <span className={styles.dots} aria-label={`熟练 ${card.review.box} / 7`}>
      {Array.from({ length: 7 }, (_, i) => (
        <i key={i} className={i < card.review.box ? styles.dotOn : ''} />
      ))}
    </span>
  );
}

type SheetProps = {
  store: FlashcardsStore;
  card?: Flashcard;
  deck?: string;
  decks: string[];
  onSaved?(card: Flashcard): void;
  onDeleted?(): void;
};

/** One card, written on directly and kept with "落笔". */
function CardSheet({ store, card, deck: initialDeck = '', decks, onSaved, onDeleted }: SheetProps) {
  const [deck, setDeck] = useState(card?.deck ?? initialDeck);
  const [question, setQuestion] = useState(card?.question ?? '');
  const [answer, setAnswer] = useState(card?.answer ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [confirm, setConfirm] = useState(false);

  // An edit from another window shows up unless this sheet has unsaved words.
  const seen = useRef(card);
  useEffect(() => {
    const before = seen.current;
    seen.current = card;
    if (!card || !before) return;
    const untouched = deck === before.deck && question === before.question && answer === before.answer;
    if (untouched) {
      setDeck(card.deck);
      setQuestion(card.question);
      setAnswer(card.answer);
    }
  }, [card]);

  const changed = !card || deck.trim() !== card.deck || question.trim() !== card.question || answer.trim() !== card.answer;
  const problem = !question.trim()
    ? '先写下问题'
    : !answer.trim()
      ? '答案还空着'
      : deck.trim().length > LIMITS.deck
        ? `题组名最多 ${LIMITS.deck} 字`
        : undefined;

  const save = async () => {
    if (problem || !changed || busy) return;
    setBusy(true);
    setNote(undefined);
    const input = { deck: deck.trim(), question: question.trim(), answer: answer.trim() };
    try {
      const saved = card ? await store.update(card.id, input) : await store.create(input);
      setNote('已记下');
      onSaved?.(saved);
    } catch (cause) {
      console.error(cause);
      setNote('没能记下，请再试一次');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.sheet}>
      <label className={styles.line}>
        <span>题组</span>
        <input value={deck} maxLength={LIMITS.deck} list="flashcards-decks" placeholder="可不填，例如 Redis" aria-label="题组" onChange={(e) => setDeck(e.target.value)} />
        <datalist id="flashcards-decks">
          {decks.filter(Boolean).map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </label>
      <textarea
        className={styles.question}
        value={question}
        maxLength={LIMITS.question}
        rows={2}
        autoFocus={!card}
        placeholder="问题，例如：RDB 和 AOF 各自的取舍？"
        aria-label="问题"
        onChange={(e) => setQuestion(e.target.value)}
      />
      <textarea
        className={styles.answer}
        value={answer}
        maxLength={LIMITS.answer}
        placeholder="答案"
        aria-label="答案"
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <footer className={styles.foot}>
        <span className={styles.stats}>
          {card
            ? card.review.due === undefined
              ? '还没背过'
              : `复习 ${card.review.reviews} 次 · 忘过 ${card.review.lapses} 次 · 下次 ${cnDay(card.review.due)}`
            : ''}
          {note && <em> · {note}</em>}
          {changed && problem && (question || answer) && <em className={styles.warn}> · {problem}</em>}
        </span>
        {card && (
          <button
            className={`${styles.tear} ${confirm ? styles.confirming : ''}`}
            onClick={() => {
              if (!confirm) return setConfirm(true);
              void store.remove(card.id).then(onDeleted, (cause: unknown) => {
                console.error(cause);
                setNote('没能删掉，请再试一次');
              });
            }}
            onBlur={() => setConfirm(false)}
          >
            {confirm ? '再点一次，删掉这题' : '删掉'}
          </button>
        )}
        <button className={styles.write} disabled={busy || !!problem || !changed} onClick={() => void save()} title="Ctrl + Enter">
          落笔
        </button>
      </footer>
    </div>
  );
}

const FORMAT = `# Redis
## RDB 和 AOF 各自的取舍？
RDB 是某一时刻的快照，恢复快、文件小，
但两次快照之间的数据可能丢失……

## 为什么用跳表实现有序集合？
……`;

/** Paste a block of Markdown (design §17.3) and import it into a deck. */
function ImportSheet({ store, deck: initialDeck, result, onResult }: { store: FlashcardsStore; deck: string; result?: string; onResult(result: string): void }) {
  const [text, setText] = useState('');
  const [deck, setDeck] = useState(initialDeck);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const { created, skipped } = await store.import(text, deck.trim() || undefined);
      if (created) setText('');
      onResult(imported(created, skipped));
    } catch (cause) {
      console.error(cause);
      onResult('没能导入：内容不合格式，或超过了 1 MB');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.sheet}>
      <h2 className={styles.sheetTitle}>粘贴导入</h2>
      <p className={styles.format}>
        每题用 <code>##</code> 或 <code>###</code> 标题写问题，下面写答案；<code>#</code> 标题是题组。和已有的题重复、没有答案或超长（问题 500 字、答案 10000 字以内）的会跳过。
      </p>
      <pre className={styles.example}>{FORMAT}</pre>
      <label className={styles.line}>
        <span>没写 # 题组的，放进</span>
        <input value={deck} maxLength={LIMITS.deck} placeholder="未分组" aria-label="导入到题组" onChange={(e) => setDeck(e.target.value)} />
      </label>
      <textarea className={styles.paste} value={text} placeholder="把整理好的八股粘贴到这里……" aria-label="粘贴的八股" onChange={(e) => setText(e.target.value)} />
      <footer className={styles.foot}>
        <span className={styles.stats}>{result}</span>
        <button className={styles.write} disabled={busy || !text.trim()} onClick={() => void go()}>
          导入
        </button>
      </footer>
    </div>
  );
}
