import type { Badge, Json, ShellState, UnfoldSide, UpdateState } from '@featherlog/contracts';
import type { Kernel } from '@featherlog/kernel';

type Dock = { width: number; height: number; expanded: boolean };
/** Where the user has dragged the scroll to, in the simulated desktop. */
export type DockPlace = 'right' | 'left';
/** What the pretend GitHub release answers when the updater checks (design §12.2). */
export type UpdateScenario = 'self' | 'manual' | 'none' | 'error';
export const UPDATE_SCENARIOS: Record<UpdateScenario, string> = {
  self: '能自更新',
  manual: '需手动下载',
  none: '没有新版',
  error: '检查失败',
};
const NEXT = { version: '0.2.0', notes: '· 任务日志可以直接新建和修订任务\n· 设置页新增"更新"一节\n· 修正卷轴在左半屏时的展开方向' };

/**
 * What the Electron shell's main process does for shell/* (design §6.5),
 * plus the window state the playground draws: panel open, dock size.
 */
export function createHostShell(kernel: Kernel) {
  const bus = kernel.createBus('shell');
  let state: ShellState = { view: 'collapsed', badges: {}, panel: {} };
  let panelOpen = false;
  let dock: Dock = { width: 0, height: 0, expanded: false };
  let place: DockPlace = 'right';
  let scenario: UpdateScenario = 'self';
  let update: UpdateState = { current: '0.1.0', status: 'idle' };
  const listeners = new Set<() => void>();
  const sideListeners = new Set<(side: UnfoldSide) => void>();
  let snapshot: { panelOpen: boolean; dock: Dock; place: DockPlace; scenario: UpdateScenario } = { panelOpen, dock, place, scenario };
  const changed = () => {
    snapshot = { panelOpen, dock, place, scenario };
    listeners.forEach((listener) => listener());
  };
  // Design §9.3: unfold toward the middle of the screen.
  const side = (): UnfoldSide => (place === 'right' ? 'left' : 'right');
  const setView = (view: ShellState['view'], extra: { tabId?: string; params?: Json } = {}) => {
    state = { ...state, view };
    bus.emit('shell/view-changed', { view, ...extra });
  };

  bus.handle('shell/state', () => state);
  bus.handle('shell/open-panel', ({ tab, params }) => {
    panelOpen = true;
    state = { ...state, panel: { ...(tab ? { tab } : {}), ...(params !== undefined ? { params } : {}) } };
    setView('panel', { ...(tab ? { tabId: tab } : {}), ...(params !== undefined ? { params } : {}) });
    changed();
    return null;
  });
  bus.handle('shell/set-badge', ({ iconId, badge }) => {
    state = { ...state, badges: { ...state.badges, [iconId]: badge as Badge | null } };
    bus.emit('shell/badge-changed', { iconId, badge });
    return null;
  });
  bus.handle('shell/notify', (notification) => {
    bus.emit('shell/notified', { id: crypto.randomUUID(), notification });
    return null;
  });

  // A stand-in for electron-updater: checking, downloading in steps, then ready.
  const setUpdate = (next: UpdateState) => {
    update = next;
    bus.emit('shell/update-changed', next);
  };
  const download = (percent: number) => {
    if (percent < 100) {
      setUpdate({ current: update.current, status: 'downloading', version: NEXT.version, percent });
      setTimeout(() => download(Math.min(100, percent + 9 + Math.random() * 14)), 260);
      return;
    }
    setUpdate({ current: update.current, status: 'ready', ...NEXT });
    bus.emit('shell/notified', {
      id: crypto.randomUUID(),
      notification: { title: '新版本已备好', body: `v${NEXT.version} · 退出时自动安装，也可以在设置里立即重启`, icon: 'feather', durationMs: 8000 },
    });
  };
  bus.handle('shell/update-state', () => update);
  bus.handle('shell/check-update', () => {
    if (update.status === 'checking' || update.status === 'downloading') return null;
    const { current } = update;
    setUpdate({ current, status: 'checking' });
    setTimeout(() => {
      const checkedAt = new Date().toISOString();
      if (scenario === 'none') setUpdate({ current, status: 'latest', checkedAt });
      else if (scenario === 'error') setUpdate({ current, status: 'error', message: '连不上 GitHub', checkedAt });
      else if (scenario === 'manual')
        setUpdate({ current, status: 'manual', url: `https://github.com/muyuzhong/Featherlog/releases/tag/v${NEXT.version}`, ...NEXT });
      else download(0);
    }, 900);
    return null;
  });
  bus.handle('shell/apply-update', () => {
    if (update.status === 'ready') {
      console.info(`[update] 演示台：退出并安装 v${update.version}`);
      setUpdate({ current: update.version, status: 'latest', checkedAt: new Date().toISOString() });
    } else if (update.status === 'manual') {
      console.info(`[update] 演示台：打开 ${update.url}`);
    } else {
      throw Object.assign(new Error('No update to apply'), { code: 'shell/no-update' });
    }
    return null;
  });

  return {
    bus,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    closePanel() {
      if (!panelOpen) return;
      panelOpen = false;
      setView(dock.expanded ? 'preview' : 'collapsed');
      changed();
    },
    side,
    onSide(listener: (side: UnfoldSide) => void) {
      sideListeners.add(listener);
      return () => sideListeners.delete(listener);
    },
    /** Pretend the user dragged the scroll to the other half of the screen (only while collapsed). */
    moveDock(next: DockPlace) {
      if (next === place || dock.expanded) return;
      place = next;
      sideListeners.forEach((listener) => listener(side()));
      changed();
    },
    /** Switch what the next update check finds, and start over as a fresh run would. */
    cycleUpdateScenario() {
      const all = Object.keys(UPDATE_SCENARIOS) as UpdateScenario[];
      scenario = all[(all.indexOf(scenario) + 1) % all.length]!;
      setUpdate({ current: '0.1.0', status: 'idle' });
      changed();
    },
    resizeDock(next: Dock) {
      const expandedChanged = next.expanded !== dock.expanded;
      dock = next;
      if (expandedChanged && !panelOpen) setView(next.expanded ? 'preview' : 'collapsed');
      changed();
    },
  };
}

export type HostShell = ReturnType<typeof createHostShell>;
