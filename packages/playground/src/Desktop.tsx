import type { Envelope, Json } from '@featherlog/contracts';
import type { Kernel } from '@featherlog/kernel';
import { PAPERS, type Paper } from '@featherlog/shell/renderer';
import { CollapsedApp, PanelApp, type WindowRuntime } from '@featherlog/shell/renderer/app';
import { motion } from 'motion/react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SettingsHost } from './host/settings';
import type { HostShell } from './host/shell';

type Props = {
  shell: HostShell;
  settings: SettingsHost;
  collapsed: WindowRuntime;
  panel: WindowRuntime;
  busLog: { entries: Envelope[] };
  kernel: Kernel;
  onNextDay(): void;
  onReset(): void;
};

function useShellSetting<T extends Json>(settings: SettingsHost, key: string): T {
  const [value, setValue] = useState(() => settings.all().shell?.[key] as T);
  useEffect(() => settings.onChange((scope, k, v) => scope === 'shell' && k === key && setValue(v as T)), [settings, key]);
  return value;
}

/**
 * A pretend desktop. Each simulated window clips its content to the size the
 * app asked for, like a real Electron window would.
 */
export function Desktop({ shell, settings, collapsed, panel, busLog, kernel, onNextDay, onReset }: Props) {
  const { panelOpen, dock, place } = useSyncExternalStore(shell.subscribe, shell.getSnapshot);
  const [bounds, setBounds] = useState(false);

  return (
    <div className="desktop">
      <div className="hint" style={{ opacity: panelOpen ? 0 : 1 }}>
        <b>羽记</b>
        <span>把鼠标移到屏幕边缘的卷轴上 · 点击卷轴翻开任务日志</span>
      </div>

      <motion.div
        className="window"
        initial={false}
        animate={panelOpen ? { opacity: 1, scale: 1, y: 0 } : { opacity: 0, scale: 0.97, y: 12 }}
        transition={{ duration: 0.32, ease: [0.22, 0.8, 0.32, 1] }}
        style={{ pointerEvents: panelOpen ? 'auto' : 'none', visibility: panelOpen ? 'visible' : 'hidden' }}
      >
        <PanelApp runtime={panel} />
      </motion.div>

      <div
        className={`dock ${bounds ? 'bounds' : ''}`}
        style={{
          width: dock.width,
          height: dock.height,
          [place]: 24,
          top: `calc((100vh - ${dock.height}px) / 2)`,
          justifyContent: place === 'left' ? 'flex-start' : 'flex-end',
        }}
      >
        <CollapsedApp runtime={collapsed} />
      </div>

      <DevTools
        shell={shell}
        place={place}
        settings={settings}
        busLog={busLog}
        kernel={kernel}
        bounds={bounds}
        onBounds={() => setBounds(!bounds)}
        onNextDay={onNextDay}
        onReset={onReset}
      />
    </div>
  );
}

type DevProps = {
  shell: HostShell;
  place: 'left' | 'right';
  settings: SettingsHost;
  busLog: { entries: Envelope[] };
  kernel: Kernel;
  bounds: boolean;
  onBounds(): void;
  onNextDay(): void;
  onReset(): void;
};

function DevTools({ shell, place, settings, busLog, kernel, bounds, onBounds, onNextDay, onReset }: DevProps) {
  const paper = useShellSetting<Paper>(settings, 'paper');
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<Envelope[]>([]);
  useEffect(() => {
    if (!showLog) return;
    setLog([...busLog.entries]);
    return kernel.observe(() => queueMicrotask(() => setLog([...busLog.entries])));
  }, [kernel, busLog, showLog]);

  const papers = Object.keys(PAPERS) as Paper[];
  return (
    <div className="devtools">
      <div className="devbar">
        <span>dev</span>
        <button onClick={() => settings.set('shell', 'paper', papers[(papers.indexOf(paper) + 1) % papers.length]!)}>
          纸张：{PAPERS[paper].label}
        </button>
        <button onClick={() => shell.moveDock(place === 'right' ? 'left' : 'right')} title="模拟把卷轴拖到屏幕另一侧">
          卷轴在：{place === 'right' ? '右侧' : '左侧'}
        </button>
        <button onClick={onBounds}>{bounds ? '隐藏窗口边界' : '窗口边界'}</button>
        <button onClick={onNextDay}>翌日 →</button>
        <button onClick={() => setShowLog(!showLog)}>{showLog ? '收起总线' : '总线记录'}</button>
        <button onClick={onReset}>重置</button>
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
