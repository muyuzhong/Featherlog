import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { EXPANDED, SPRING } from '../lib/geometry';
import { noticeText } from '../lib/i18n';
import { useAppState, useStore, useT } from '../state/react';
import { Kbd } from './bits';
import { ChevronDown, Pin, Search } from './icons';
import { isImeKey } from './InlineText';
import { NotesPanel } from './NotesPanel';
import { NowDeck } from './NowDeck';
import { paletteItems, runPaletteAction } from './palette';
import { SettingsButton } from './SettingsPopover';
import { TaskPanel } from './TaskPanel';

/** The drawer is laid out at its full size and anchored to the bottom, so the growing shell reveals it upward. */
export const DRAWER_INSET = 6;
const DRAWER_HEIGHT = EXPANDED.height - DRAWER_INSET * 2 - 2;

/** fill: the panel window, where the drawer is the whole page from the first paint. */
export function Drawer({ fill = false }: { fill?: boolean }) {
  const { ui } = useAppState();
  const store = useStore();
  const t = useT();
  return (
    <motion.div
      className="drawer"
      style={{ height: fill ? '100%' : DRAWER_HEIGHT }}
      initial={fill ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.08 } }}
      transition={{ duration: 0.16 }}
    >
      <HeaderBar />
      <NowDeck />
      <div className="lower">
        <TaskPanel />
        <NotesPanel />
      </div>
      <AnimatePresence>
        {ui.notice && (
          <motion.button
            type="button"
            className="toast"
            role="status"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={SPRING}
            onClick={() => store.dismissNotice()}
          >
            {noticeText(t, ui.notice)}
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** The wordmark, the search, and three quiet buttons: settings, pin, collapse. */
function HeaderBar() {
  const store = useStore();
  const { settings } = useAppState();
  const t = useT();

  return (
    <header className="head">
      <div className="head-left">
        <span className="wordmark">{t.appName}</span>
      </div>
      <SearchBox />
      <div className="head-right">
        <SettingsButton />
        <button
          type="button"
          className="icon-btn pin-btn"
          aria-pressed={settings.pinned}
          aria-label={settings.pinned ? t.head.unpin : t.head.pin}
          title={settings.pinned ? t.head.unpinHint : t.head.pinHint}
          onClick={() => void store.togglePin()}
        >
          <Pin />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t.head.collapse}
          aria-expanded={true}
          title={t.head.collapseHint}
          onClick={() => store.setExpanded(false)}
        >
          <ChevronDown />
        </button>
      </div>
    </header>
  );
}

function SearchBox() {
  const store = useStore();
  const state = useAppState();
  const t = useT();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const items = useMemo(() => (open ? paletteItems(state, query) : []), [open, state, query]);

  useEffect(() => {
    if (state.ui.searchSignal === 0) return;
    input.current?.focus();
    input.current?.select();
  }, [state.ui.searchSignal]);

  useEffect(() => setActive(0), [query]);

  const run = (index: number) => {
    const item = items[index];
    if (!item) return;
    runPaletteAction(store, item.action);
    setQuery('');
    setOpen(false);
    input.current?.blur();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length || 1;
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
      setOpen(false);
      e.currentTarget.blur();
    }
  };

  return (
    <div className="search" data-open={open || undefined}>
      <Search />
      <input
        ref={input}
        role="combobox"
        aria-label={t.search.label}
        aria-expanded={open && items.length > 0}
        aria-controls="palette"
        aria-activedescendant={open && items[active] ? `palette-${active}` : undefined}
        placeholder={t.search.placeholder}
        value={query}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <Kbd>Ctrl K</Kbd>
      {open && items.length > 0 && (
        <ul className="palette" id="palette" role="listbox" aria-label={t.search.results}>
          {items.map((item, i) => (
            <li
              key={item.key}
              id={`palette-${i}`}
              role="option"
              aria-selected={i === active}
              className="palette-item"
              // Keep the input focused so the click is not lost to its blur.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(i)}
            >
              <span className="palette-group">{t.palette.groups[item.group]}</span>
              <span className="palette-label">{item.label}</span>
              {item.hint && <span className="palette-hint tnum">{item.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
