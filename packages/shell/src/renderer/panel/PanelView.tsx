import type { Json, PanelTabContribution } from '@featherlog/contracts';
import { useState, type ReactNode } from 'react';
import { InkIcon } from '../icons';
import { SlotMount } from '../slots/SlotMount';
import type { SlotRegistry } from '../slots/registry';
import styles from './PanelView.module.css';

/** The shell's own settings page, opened from the dock's context menu (design §6.4). */
export const SETTINGS_TAB = 'shell/settings';

type Props = {
  registry: SlotRegistry;
  tabs: PanelTabContribution[];
  activeTab: string;
  params?: Json;
  /** The shell's settings page; shown as a tab of its own when given. */
  settings?: ReactNode;
  visible: boolean;
  onSelectTab(id: string): void;
  onClose(): void;
  onQuit(): Promise<void>;
};

/** The full panel: a leather-bound frame hosting one plugin tab at a time. */
export function PanelView({ registry, tabs, activeTab, params, settings, visible, onSelectTab, onClose, onQuit }: Props) {
  const ordered = [...tabs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const [quitting, setQuitting] = useState(false);
  const [quitError, setQuitError] = useState<string>();
  const quit = async () => {
    if (quitting) return;
    setQuitting(true);
    setQuitError(undefined);
    try {
      await onQuit();
    } catch (cause: unknown) {
      setQuitError(`退出失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setQuitting(false);
    }
  };
  return (
    <div className={`${styles.panel} fl-leather`}>
      <header className={styles.bar}>
        <span className={styles.mark}>羽 记</span>
        {/* With a settings page there is always somewhere to go back from, so the tabs always show. */}
        {(ordered.length > 1 || settings !== undefined) && (
          <nav className={styles.tabs}>
            {ordered.map((tab) => (
              <button key={tab.id} className={tab.id === activeTab ? styles.active : ''} onClick={() => onSelectTab(tab.id)}>
                {tab.title}
              </button>
            ))}
          </nav>
        )}
        {settings !== undefined && (
          <button
            className={`${styles.settings} ${activeTab === SETTINGS_TAB ? styles.active : ''}`}
            onClick={() => onSelectTab(SETTINGS_TAB)}
          >
            设置
          </button>
        )}
        {quitError && <span className={styles.quitError} role="alert">{quitError}</span>}
        <button className={styles.quit} onClick={() => void quit()} disabled={quitting}>
          {quitting ? '退出中…' : '退出'}
        </button>
        <button className={styles.close} onClick={onClose} aria-label="收起">
          <InkIcon name="x" size={15} />
        </button>
      </header>
      {ordered.map((tab) => (
        <SlotMount
          key={tab.id}
          registry={registry}
          kind="panel.tab"
          id={tab.id}
          params={tab.id === activeTab ? params : undefined}
          visible={visible && tab.id === activeTab}
          className={styles.content}
          style={{ display: tab.id === activeTab ? undefined : 'none' }}
        />
      ))}
      {settings !== undefined && (
        <div className={styles.content} style={{ display: activeTab === SETTINGS_TAB ? undefined : 'none' }}>
          {settings}
        </div>
      )}
    </div>
  );
}
