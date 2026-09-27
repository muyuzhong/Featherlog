import type { Badge, Envelope, PluginManifest } from '@featherlog/contracts';
import { CollapsedView, PAPERS, PanelView, setPaper, type Paper, type SlotRegistry } from '@featherlog/shell/renderer';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import type { MockKernel } from './mock/kernel';
import { loadPreference, savePreference } from './preferences';
import { useValue, type Value } from './value';

type Props = {
  registry: SlotRegistry;
  manifests: PluginManifest[];
  badges: Value<Record<string, Badge | null>>;
  panel: Value<{ open: boolean; tab: string }>;
  kernel: MockKernel;
  onNextDay(): void;
};

/** A pretend desktop: the collapsed scroll on the right edge, the panel as a floating window. */
export function Desktop({ registry, manifests, badges, panel, kernel, onNextDay }: Props) {
  const badgeValues = useValue(badges);
  const { open, tab } = useValue(panel);
  const icons = manifests.flatMap((m) => m.contributes?.collapsedIcons ?? []);
  const tabs = manifests.flatMap((m) => m.contributes?.panelTabs ?? []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') panel.set({ ...panel.get(), open: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);

  return (
    <div className="desktop">
      <div className="hint" style={{ opacity: open ? 0 : 1 }}>
        <b>羽记</b>
        <span>把鼠标移到屏幕右缘的卷轴上 · 点击卷轴翻开任务日志</span>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            className="window"
            initial={{ opacity: 0, scale: 0.97, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ duration: 0.32, ease: [0.22, 0.8, 0.32, 1] }}
          >
            <PanelView
              registry={registry}
              tabs={tabs}
              activeTab={tab}
              visible={open}
              onSelectTab={(id) => panel.set({ open, tab: id })}
              onClose={() => panel.set({ open: false, tab })}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="edge">
        <CollapsedView
          registry={registry}
          icons={icons}
          badges={badgeValues}
          onOpen={(icon) => panel.set({ open: true, tab: icon.opens ?? tab })}
        />
      </div>

      <DevTools kernel={kernel} onNextDay={onNextDay} />
    </div>
  );
}

function DevTools({ kernel, onNextDay }: { kernel: MockKernel; onNextDay(): void }) {
  const [showLog, setShowLog] = useState(false);
  const [paper, setPaperState] = useState<Paper>(() => loadPreference('paper', 'vellum'));
  const cyclePaper = () => {
    const names = Object.keys(PAPERS) as Paper[];
    const next = names[(names.indexOf(paper) + 1) % names.length]!;
    setPaper(next);
    setPaperState(next);
    savePreference('paper', next);
  };

  const [log, setLog] = useState<Envelope[]>([]);
  useEffect(() => {
    if (!showLog) return;
    setLog([...kernel.log]);
    return kernel.observe(() => setLog([...kernel.log]));
  }, [kernel, showLog]);

  return (
    <div className="devtools">
      <div className="devbar">
        <span>dev</span>
        <button onClick={cyclePaper}>纸张：{PAPERS[paper].label}</button>
        <button onClick={onNextDay}>翌日 →</button>
        <button onClick={() => setShowLog(!showLog)}>{showLog ? '收起总线' : '总线记录'}</button>
        <button onClick={() => location.reload()}>重置</button>
      </div>
      {showLog && (
        <ol className="buslog">
          {log
            .slice(-60)
            .reverse()
            .map((e) => (
              <li key={`${e.id}-${e.kind}`} className={e.kind}>
                <b>{e.kind === 'response' ? '↩' : e.kind === 'request' ? '→' : '•'}</b> {e.type}
                <small>{e.source}</small>
              </li>
            ))}
        </ol>
      )}
    </div>
  );
}
