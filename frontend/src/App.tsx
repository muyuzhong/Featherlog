import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useEffect, useLayoutEffect } from 'react';
import { COLLAPSED, dockGeometry, SPRING } from './lib/geometry';
import { isTypingTarget, keyAction } from './lib/keys';
import { messages } from './lib/i18n';
import { useAppState, useStore } from './state/react';
import { resolvedTheme } from './state/store';
import { Drawer, DRAWER_INSET } from './ui/Drawer';
import { PreviewBar } from './ui/PreviewBar';
import { Tray } from './ui/Tray';

const TRAY_INSET = (COLLAPSED.windowHeight - COLLAPSED.barHeight) / 2;

export function App() {
  const store = useStore();
  const state = useAppState();
  const theme = resolvedTheme(state);
  const { expanded } = state.ui;
  const { language } = state.settings;
  const mode = store.mode;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.mode = mode;
    root.style.colorScheme = theme === 'graphite' ? 'dark' : 'light';
  }, [theme, mode]);

  // Screen readers, hyphenation and the CJK font fallback all read <html lang>.
  useLayoutEffect(() => {
    const t = messages(language);
    document.documentElement.lang = t.htmlLang;
    document.title = t.appName;
  }, [language]);

  useEffect(() => {
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    if (!mq) return;
    store.setSystemDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => store.setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [store]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = keyAction(e, { slotCount: store.getState().slots.length });
      if (!action) return;
      switch (action.type) {
        case 'focus-slot':
          e.preventDefault();
          void store.focusSlotAt(action.index);
          return;
        case 'new-slot':
          e.preventDefault();
          store.requestNewSlot();
          return;
        case 'toggle-pin':
          // Ctrl+P must never reach the webview's print dialog.
          e.preventDefault();
          void store.togglePin();
          return;
        case 'search':
          e.preventDefault();
          store.requestSearch();
          return;
        case 'escape':
          if (isTypingTarget(e.target)) {
            (e.target as HTMLElement).blur();
            return;
          }
          if (store.collapseIfUnpinned()) e.preventDefault();
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  useEffect(() => {
    if (!store.collapseOnBlur) return;
    const onBlur = () => store.collapseIfUnpinned();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [store]);

  if (store.bar) {
    // The standalone 312×40 bar window: the drum fills it, and it never grows into the drawer.
    return (
      <MotionConfig reducedMotion="user" transition={SPRING}>
        <div className="stage" data-mode="bar" data-runtime={store.bridge.kind}>
          <div className="shell" data-expanded="false">
            <Tray />
          </div>
        </div>
      </MotionConfig>
    );
  }

  if (store.panel) {
    // The opaque popup window: the drawer fills it edge to edge, with no
    // margin for a transparent window to show through and nothing to animate.
    return (
      <MotionConfig reducedMotion="user" transition={SPRING}>
        <div className="stage" data-mode="panel" data-runtime={store.bridge.kind}>
          <div className="shell" data-expanded="true">
            <Drawer fill />
          </div>
        </div>
      </MotionConfig>
    );
  }

  const geom = dockGeometry(expanded, state.slots.length, state.settings.pinned);
  const inset = expanded ? DRAWER_INSET : TRAY_INSET;

  return (
    <MotionConfig reducedMotion="user" transition={SPRING}>
      <div className="stage" data-mode="dock" data-runtime={store.bridge.kind} data-expanded={expanded}>
        {store.bridge.kind === 'mock' && <PreviewBar />}
        <motion.div
          className="shell"
          data-expanded={expanded}
          initial={false}
          animate={{
            width: geom.width - inset * 2,
            height: geom.height - inset * 2,
            bottom: inset,
            borderRadius: expanded ? 22 : 14,
          }}
          transition={SPRING}
        >
          <AnimatePresence initial={false}>
            {expanded ? <Drawer key="drawer" /> : <Tray key="tray" />}
          </AnimatePresence>
        </motion.div>
      </div>
    </MotionConfig>
  );
}
