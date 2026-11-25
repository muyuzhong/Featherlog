import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { LANGUAGE_NAMES } from '../lib/i18n';
import { LANGUAGES, type Language } from '../rpc/types';
import { useAppState, useStore, useT } from '../state/react';
import { themeChoiceOf, type ThemeChoice } from '../state/store';
import { Segmented } from './bits';
import { Minus, Monitor, Moon, Plus, SettingsIcon, Sun } from './icons';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** The header's gear: opens the settings popover right under itself. */
export function SettingsButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  return (
    <div className="settings-anchor" ref={anchor}>
      <button
        ref={button}
        type="button"
        className="icon-btn settings-btn"
        aria-label={t.head.settings}
        title={t.head.settings}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? 'settings-popover' : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <SettingsIcon />
      </button>
      <AnimatePresence>
        {open && <SettingsPopover key="settings" anchor={anchor} returnFocus={button} onClose={close} />}
      </AnimatePresence>
    </div>
  );
}

/**
 * Language, theme, sound, the day's rollover hour, and — once the bar has
 * been dragged somewhere — a way to put it back. Nothing else, and no volume
 * slider: the sound is on or off. A click outside or Esc closes it.
 */
export function SettingsPopover({
  anchor,
  returnFocus,
  onClose,
}: {
  /** the gear and the popover together: a press inside is not "outside" */
  anchor: RefObject<HTMLElement | null>;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const store = useStore();
  const state = useAppState();
  const t = useT();
  const { settings } = state;

  useEffect(() => {
    const onPointerDown = (e: Event) => {
      if (!anchor.current?.contains(e.target as Node)) onClose();
    };
    // Esc closes the popover only: caught before the window's own Esc, which would hide the panel.
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      const inside = anchor.current?.contains(document.activeElement);
      onClose();
      if (inside) returnFocus.current?.focus();
    };
    // The panel window hides when it loses focus; it should come back without the popover.
    window.addEventListener('blur', onClose);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('blur', onClose);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [anchor, returnFocus, onClose]);

  const hour = settings.dayStartHour;
  const stepHour = (delta: number) => void store.setDayStartHour(hour + delta);
  const onHourKey = (e: KeyboardEvent<HTMLElement>) => {
    const next =
      e.key === 'ArrowUp' || e.key === 'ArrowRight'
        ? hour + 1
        : e.key === 'ArrowDown' || e.key === 'ArrowLeft'
          ? hour - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? 23
              : null;
    if (next === null) return;
    e.preventDefault();
    void store.setDayStartHour(next);
  };

  return (
    <motion.div
      id="settings-popover"
      className="settings-pop"
      role="dialog"
      aria-label={t.settings.title}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4, transition: { duration: 0.08 } }}
    >
      <div className="settings-row">
        <span className="settings-label">{t.settings.language}</span>
        <Segmented<Language>
          id="language"
          label={t.settings.language}
          compact
          value={settings.language}
          onChange={(language) => void store.setLanguage(language)}
          options={LANGUAGES.map((language) => ({ value: language, label: LANGUAGE_NAMES[language] }))}
        />
      </div>
      <div className="settings-row">
        <span className="settings-label">{t.settings.theme}</span>
        <Segmented<ThemeChoice>
          id="theme"
          label={t.settings.theme}
          compact
          value={themeChoiceOf(state)}
          onChange={(choice) => store.setThemeChoice(choice)}
          options={[
            { value: 'stone', label: <><Sun />{t.settings.stone}</> },
            { value: 'graphite', label: <><Moon />{t.settings.graphite}</> },
            { value: 'system', label: <><Monitor />{t.settings.system}</> },
          ]}
        />
      </div>
      <div className="settings-row">
        <span className="settings-label">{t.settings.sound}</span>
        <button
          type="button"
          role="switch"
          aria-checked={settings.sound}
          aria-label={t.settings.sound}
          className="switch"
          onClick={() => void store.toggleSound()}
        >
          <span className="switch-track" aria-hidden="true">
            <span className="switch-knob" />
          </span>
          {settings.sound ? t.settings.soundOn : t.settings.soundOff}
        </button>
      </div>
      <div className="settings-row">
        <span className="settings-label" title={t.settings.dayStartHint}>
          {t.settings.dayStart}
        </span>
        <span className="hour-step">
          <button type="button" className="icon-btn tiny" aria-label={t.settings.earlier} onClick={() => stepHour(-1)}>
            <Minus />
          </button>
          <span
            className="hour-value tnum"
            role="spinbutton"
            tabIndex={0}
            aria-label={t.settings.dayStart}
            aria-valuemin={0}
            aria-valuemax={23}
            aria-valuenow={hour}
            aria-valuetext={`${pad2(hour)}:00`}
            title={t.settings.dayStartHint}
            onKeyDown={onHourKey}
          >
            {pad2(hour)}:00
          </span>
          <button type="button" className="icon-btn tiny" aria-label={t.settings.later} onClick={() => stepHour(1)}>
            <Plus />
          </button>
        </span>
      </div>
      {settings.barX != null && (
        <div className="settings-row settings-foot">
          <button type="button" className="text-btn" onClick={() => void store.resetBarPosition()}>
            {t.settings.resetBar}
          </button>
        </div>
      )}
    </motion.div>
  );
}
