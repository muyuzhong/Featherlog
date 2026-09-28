import type { ShellNotification, ShellState, UiBus } from '@featherlog/contracts';
import { useEffect, useState } from 'react';

const EMPTY: ShellState = { view: 'collapsed', badges: {}, panel: {} };

/** The shell's UI state (design §6.5): fetched once, then kept current by shell/* events. */
export function useShellState(bus: UiBus): ShellState {
  const [state, setState] = useState<ShellState>(EMPTY);
  useEffect(() => {
    let alive = true;
    bus.request('shell/state', {}).then(
      (initial) => alive && setState(initial),
      (cause) => console.error('shell/state failed', cause),
    );
    const stops = [
      bus.on('shell/badge-changed', ({ iconId, badge }) =>
        setState((s) => ({ ...s, badges: { ...s.badges, [iconId]: badge } })),
      ),
      bus.on('shell/view-changed', ({ view, tabId, params }) =>
        setState((s) => ({
          ...s,
          view,
          panel: view === 'panel' ? { ...(tabId ? { tab: tabId } : {}), ...(params !== undefined ? { params } : {}) } : s.panel,
        })),
      ),
    ];
    return () => {
      alive = false;
      stops.forEach((stop) => stop());
    };
  }, [bus]);
  return state;
}

export type Toast = { id: string; notification: ShellNotification };

/** Notifications from "shell/notified", each removed after its duration. */
export function useNotifications(bus: UiBus): [Toast[], (id: string) => void] {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    const timers = new Map<string, number>();
    const dismiss = (id: string) => {
      window.clearTimeout(timers.get(id));
      timers.delete(id);
      setToasts((list) => list.filter((t) => t.id !== id));
    };
    const stop = bus.on('shell/notified', ({ id, notification }) => {
      setToasts((list) => [...list.slice(-2), { id, notification }]);
      timers.set(id, window.setTimeout(() => dismiss(id), notification.durationMs ?? 3000));
    });
    return () => {
      stop();
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [bus]);
  return [toasts, (id) => setToasts((list) => list.filter((t) => t.id !== id))];
}
