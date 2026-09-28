import { useLayoutEffect, useRef, useState } from 'react';
import { CollapsedView } from '../collapsed/CollapsedView';
import type { WindowRuntime } from './runtime';
import { useNotifications, useShellState } from './shell-state';
import { useSetting } from './use-setting';
import { Toasts } from './Toasts';
import styles from './App.module.css';

/**
 * The collapsed window: the scroll, its unrolling preview and notifications.
 * The Electron window is sized to exactly this content (design §6.4 dock.resize).
 */
export function CollapsedApp({ runtime }: { runtime: WindowRuntime }) {
  const { preload, registry, shellBus, manifests } = runtime;
  const shell = useShellState(shellBus);
  const [toasts, dismiss] = useNotifications(shellBus);
  const edge = useSetting<'left' | 'right'>(runtime, 'shell', 'edge') ?? 'right';
  const [expanded, setExpanded] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const icons = manifests.flatMap((m) => m.contributes?.collapsedIcons ?? []);

  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const report = () => {
      const { width, height } = el.getBoundingClientRect();
      preload.dock.resize({ width: Math.ceil(width), height: Math.ceil(height), expanded });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [preload, expanded]);

  return (
    <div
      ref={content}
      className={`${styles.collapsed} ${edge === 'left' ? styles.left : ''}`}
      onContextMenu={(event) => {
        event.preventDefault();
        preload.dock.menu();
      }}
    >
      {toasts.length > 0 && <Toasts toasts={toasts} onDismiss={dismiss} />}
      <CollapsedView
        registry={registry}
        icons={icons}
        badges={shell.badges}
        edge={edge}
        draggable={!preload.platform.dock.anchored}
        onOpen={(icon) => void shellBus.request('shell/open-panel', icon.opens ? { tab: icon.opens } : {}).catch(console.error)}
        onPreviewChange={(id) => setExpanded(id !== null)}
      />
    </div>
  );
}
