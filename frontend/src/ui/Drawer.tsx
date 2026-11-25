import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { EXPANDED, SPRING } from '../lib/geometry';
import { periodLabel } from '../lib/time';
import { useAppState, useStore } from '../state/react';
import { themeChoiceOf, type ThemeChoice } from '../state/store';
import { BAR_MODES, type BarMode } from '../rpc/types';
import { Kbd, Segmented } from './bits';
import { ChevronDown, Monitor, Moon, Pin, Search, Sun, Volume, VolumeOff } from './icons';
import { isImeKey } from './InlineText';
import { NotesPanel } from './NotesPanel';
import { NowDeck } from './NowDeck';
import { BAR_MODE_LABEL, paletteItems, runPaletteAction } from './palette';
import { TaskPanel } from './TaskPanel';

/** The drawer is laid out at its full size and anchored to the bottom, so the growing shell reveals it upward. */
export const DRAWER_INSET = 6;
const DRAWER_HEIGHT = EXPANDED.height - DRAWER_INSET * 2 - 2;

/** fill: the panel window, where the drawer is the whole page from the first paint. */
export function Drawer({ fill = false }: { fill?: boolean }) {
  const { ui } = useAppState();
  const store = useStore();
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
            {ui.notice}
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function HeaderBar() {
  const store = useStore();
  const state = useAppState();
  const { settings, periodKey } = state;

  return (
    <header className="head">
      <div className="head-left">
        <span className="wordmark">羽记</span>
        <span className="head-date">{periodLabel(periodKey)}</span>
        <span className="head-sub tnum">{settings.dayStartHour}:00 换日</span>
      </div>
      <SearchBox />
      <div className="head-right">
        <Segmented<BarMode>
          id="bar-mode"
          label="常驻条"
          compact
          value={settings.barMode}
          onChange={(mode) => void store.setBarMode(mode)}
          options={BAR_MODES.map((mode) => ({ value: mode, label: BAR_MODE_LABEL[mode], name: `常驻条：${BAR_MODE_LABEL[mode]}` }))}
        />
        <Segmented<ThemeChoice>
          id="theme"
          label="主题"
          compact
          value={themeChoiceOf(state)}
          onChange={(choice) => store.setThemeChoice(choice)}
          options={[
            { value: 'stone', label: <Sun />, name: '纸石浅色' },
            { value: 'graphite', label: <Moon />, name: '石墨暗色' },
            { value: 'system', label: <Monitor />, name: '跟随系统' },
          ]}
        />
        <button
          type="button"
          className="icon-btn"
          aria-label={settings.sound ? '关闭音效' : '打开音效'}
          title={settings.sound ? '音效：开' : '音效：关'}
          onClick={() => void store.toggleSound()}
        >
          {settings.sound ? <Volume /> : <VolumeOff />}
        </button>
        <button
          type="button"
          className="icon-btn pin-btn"
          aria-pressed={settings.pinned}
          aria-label={settings.pinned ? '取消钉住' : '钉住面板'}
          title={settings.pinned ? '取消钉住 · Ctrl+P' : '钉住面板 · Ctrl+P'}
          onClick={() => void store.togglePin()}
        >
          <Pin />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="收起"
          aria-expanded={true}
          title="收起 · Esc"
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
        aria-label="搜索槽位、任务或命令"
        aria-expanded={open && items.length > 0}
        aria-controls="palette"
        aria-activedescendant={open && items[active] ? `palette-${active}` : undefined}
        placeholder="跳到槽位、任务或命令…"
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
        <ul className="palette" id="palette" role="listbox" aria-label="搜索结果">
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
              <span className="palette-group">{item.group}</span>
              <span className="palette-label">{item.label}</span>
              {item.hint && <span className="palette-hint tnum">{item.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
