import { useEffect, useState } from 'react';
import { PanelView } from '../panel/PanelView';
import type { WindowRuntime } from './runtime';
import { useShellState } from './shell-state';
import styles from './App.module.css';

/** The panel window: the leather-bound frame hosting plugin tabs. */
export function PanelApp({ runtime }: { runtime: WindowRuntime }) {
  const { preload, registry, shellBus, manifests } = runtime;
  const shell = useShellState(shellBus);
  const tabs = manifests.flatMap((m) => m.contributes?.panelTabs ?? []);
  const [tab, setTab] = useState<string | undefined>();
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');

  // "shell/open-panel" decides which tab is in front; the user can switch afterwards.
  useEffect(() => {
    if (shell.panel.tab) setTab(shell.panel.tab);
  }, [shell.panel.tab, shell.panel.params]);

  // The shell hides the window instead of closing it, so visibility tells us when it is shown.
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && preload.panel.close();
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('keydown', onKey);
    };
  }, [preload]);

  const active = tab ?? [...tabs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.id ?? '';
  return (
    <div className={styles.panel}>
      <PanelView
        registry={registry}
        tabs={tabs}
        activeTab={active}
        {...(active === shell.panel.tab && shell.panel.params !== undefined ? { params: shell.panel.params } : {})}
        visible={visible}
        onSelectTab={setTab}
        onClose={() => preload.panel.close()}
      />
    </div>
  );
}
