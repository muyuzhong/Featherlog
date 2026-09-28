import type { Badge, Json, ShellState, UnfoldSide } from '@featherlog/contracts';
import type { Kernel } from '@featherlog/kernel';

type Dock = { width: number; height: number; expanded: boolean };
/** Where the user has dragged the scroll to, in the simulated desktop. */
export type DockPlace = 'right' | 'left';

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
  const listeners = new Set<() => void>();
  const sideListeners = new Set<(side: UnfoldSide) => void>();
  let snapshot: { panelOpen: boolean; dock: Dock; place: DockPlace } = { panelOpen, dock, place };
  const changed = () => {
    snapshot = { panelOpen, dock, place };
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
    resizeDock(next: Dock) {
      const expandedChanged = next.expanded !== dock.expanded;
      dock = next;
      if (expandedChanged && !panelOpen) setView(next.expanded ? 'preview' : 'collapsed');
      changed();
    },
  };
}

export type HostShell = ReturnType<typeof createHostShell>;
