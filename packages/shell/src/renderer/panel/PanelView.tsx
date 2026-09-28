import type { Json, PanelTabContribution } from '@featherlog/contracts';
import { InkIcon } from '../icons';
import { SlotMount } from '../slots/SlotMount';
import type { SlotRegistry } from '../slots/registry';
import styles from './PanelView.module.css';

type Props = {
  registry: SlotRegistry;
  tabs: PanelTabContribution[];
  activeTab: string;
  params?: Json;
  visible: boolean;
  onSelectTab(id: string): void;
  onClose(): void;
};

/** The full panel: a leather-bound frame hosting one plugin tab at a time. */
export function PanelView({ registry, tabs, activeTab, params, visible, onSelectTab, onClose }: Props) {
  const ordered = [...tabs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return (
    <div className={`${styles.panel} fl-leather`}>
      <header className={styles.bar}>
        <span className={styles.mark}>羽 记</span>
        {ordered.length > 1 && (
          <nav className={styles.tabs}>
            {ordered.map((tab) => (
              <button key={tab.id} className={tab.id === activeTab ? styles.active : ''} onClick={() => onSelectTab(tab.id)}>
                {tab.title}
              </button>
            ))}
          </nav>
        )}
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
    </div>
  );
}
