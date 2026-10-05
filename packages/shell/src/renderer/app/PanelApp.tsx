import { useEffect, useState } from 'react';
import { PanelView, SETTINGS_TAB } from '../panel/PanelView';
import { SettingsPage } from '../settings/SettingsPage';
import type { WindowRuntime } from './runtime';
import { useManifests } from './use-plugins';
import { useShellState } from './shell-state';
import styles from './App.module.css';

/** The panel window: the leather-bound frame hosting plugin tabs. */
export function PanelApp({ runtime }: { runtime: WindowRuntime }) {
  const { preload, registry, shellBus } = runtime;
  const manifests = useManifests(runtime);
  const shell = useShellState(shellBus);
  const tabs = manifests.flatMap((m) => m.contributes?.panelTabs ?? []);
  const [tab, setTab] = useState<string | undefined>();
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');

  // Every "shell/open-panel" brings its tab to the front, even the one it brought last time;
  // the user can switch afterwards. shell.panel is a new object per open.
  useEffect(() => {
    if (shell.panel.tab) setTab(shell.panel.tab);
  }, [shell.panel]);

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

  // A tab nobody provides (a removed plugin, a typo in "opens") falls back to the first one.
  const first = [...tabs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.id ?? SETTINGS_TAB;
  const active = tab !== undefined && (tab === SETTINGS_TAB || tabs.some((t) => t.id === tab)) ? tab : first;
  return (
    <div className={styles.panel}>
      <PanelView
        registry={registry}
        tabs={tabs}
        activeTab={active}
        {...(active === shell.panel.tab && shell.panel.params !== undefined ? { params: shell.panel.params } : {})}
        settings={<SettingsPage runtime={runtime} />}
        visible={visible}
        onSelectTab={setTab}
        onClose={() => preload.panel.close()}
        onQuit={async () => { await shellBus.request('shell/quit', {}); }}
      />
    </div>
  );
}
