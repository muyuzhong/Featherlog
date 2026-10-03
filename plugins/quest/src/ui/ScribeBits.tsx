import type { QuestInput, ScribeLine } from '@featherlog/contracts';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { scribeTrouble, type ScribeLink } from './scribe-link';
import styles from './scribe.module.css';

/** A line in 翎's hand, written out a stroke at a time the first time it appears. */
export function ScribeWords({ line, className = '' }: { line: ScribeLine; className?: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const chars = [...line.text];
    // Lines older than a moment are already on the page; only fresh ones are written out.
    if (Date.now() - Date.parse(line.at) > 4000) return setShown(chars.length);
    setShown(0);
    let n = 0;
    const timer = window.setInterval(() => {
      n += 1;
      setShown(n);
      if (n >= chars.length) window.clearInterval(timer);
    }, 55);
    return () => window.clearInterval(timer);
  }, [line.id, line.text, line.at]);
  const chars = [...line.text];
  return (
    <p className={`${styles.words} ${className}`} aria-label={`翎：${line.text}`}>
      <span aria-hidden>{chars.slice(0, shown).join('')}</span>
      <span className={styles.unwritten} aria-hidden>
        {chars.slice(shown).join('')}
      </span>
      <span className={`${styles.seal} ${shown >= chars.length ? styles.sealOn : ''}`} aria-hidden>
        翎
      </span>
    </p>
  );
}

type AskProps = {
  link: ScribeLink;
  onDraft(draft: { input: QuestInput; note?: string }): void;
  compact?: boolean;
};

/** "对翎说……": one sentence in, a quest draft out (design §14.3). Nothing is written until you do. */
export function AskScribe({ link, onDraft, compact = false }: AskProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string>();
  const ask = async () => {
    const said = text.trim();
    if (!said || busy) return;
    setBusy(true);
    setTrouble(undefined);
    try {
      onDraft(await link.draft(said));
      setText('');
    } catch (cause) {
      console.error(cause);
      setTrouble(scribeTrouble(cause));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) void ask();
    if (event.key === 'Escape') {
      event.stopPropagation();
      setText('');
    }
  };
  return (
    <div className={`${styles.ask} ${compact ? styles.askCompact : ''}`}>
      <input
        value={text}
        disabled={busy}
        placeholder={busy ? '翎在琢磨……' : '对翎说……比如「这个月把 Redis 八股背完」'}
        aria-label="对翎说"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKey}
      />
      {busy && <span className={styles.thinking} aria-hidden />}
      {trouble && <span className={styles.trouble}>{trouble}</span>}
    </div>
  );
}
