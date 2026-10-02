import type { Bus, Clock, ShellState } from '@featherlog/contracts';
import { invalid, isJson, record } from './validation';

export function registerShell(bus: Bus, openPanel: () => Promise<void>, clock: Clock, quit: () => void) {
  const state: ShellState = { view: 'collapsed', badges: {}, panel: {} };
  let quitTimer = () => {};
  const disposers = [
    () => quitTimer(),
    bus.handle('shell/state', () => structuredClone(state)),
    bus.handle('shell/quit', payload => {
      if (!record(payload)) invalid('Invalid quit request');
      // Reply before shutdown removes bus responders and closes the requesting window.
      quitTimer();
      quitTimer = clock.setTimeout(quit, 0);
      return null;
    }),
    bus.handle('shell/open-panel', async (payload, envelope) => {
      if (!record(payload) || (payload.tab !== undefined && typeof payload.tab !== 'string') ||
        (payload.params !== undefined && !isJson(payload.params))) invalid('Invalid panel request');
      await openPanel();
      state.panel = structuredClone(payload);
      state.view = 'panel';
      bus.emit('shell/view-changed', {
        view: 'panel', ...(payload.tab === undefined ? {} : { tabId: payload.tab }),
        ...(payload.params === undefined ? {} : { params: payload.params }),
      }, { causedBy: envelope.id });
      return null;
    }),
    bus.handle('shell/set-badge', (payload, envelope) => {
      if (!record(payload) || typeof payload.iconId !== 'string' || !payload.iconId.trim()) {
        invalid('Invalid badge icon id');
      }
      const badge = payload.badge;
      if (badge !== null && (!record(badge) ||
        !(badge.kind === 'dot' || (badge.kind === 'count' &&
          Number.isSafeInteger(badge.value) && Number(badge.value) >= 0) ||
          (badge.kind === 'progress' && typeof badge.value === 'number' &&
            badge.value >= 0 && badge.value <= 1)))) invalid('Invalid badge');
      Object.defineProperty(state.badges, payload.iconId, {
        value: structuredClone(badge), writable: true, enumerable: true, configurable: true,
      });
      bus.emit('shell/badge-changed', payload, { causedBy: envelope.id });
      return null;
    }),
    bus.handle('shell/notify', (notification, envelope) => {
      if (!record(notification) || typeof notification.title !== 'string' ||
        !notification.title.trim() ||
        ['body', 'icon'].some(key => notification[key] !== undefined &&
          typeof notification[key] !== 'string') ||
        (notification.variant !== undefined &&
          (typeof notification.variant !== 'string' ||
            !['success', 'info', 'warning'].includes(notification.variant))) ||
        (notification.durationMs !== undefined &&
          (typeof notification.durationMs !== 'number' || !Number.isFinite(notification.durationMs) ||
            notification.durationMs < 0))) invalid('Invalid notification');
      bus.emit('shell/notified', { id: crypto.randomUUID(), notification }, { causedBy: envelope.id });
      return null;
    }),
  ];
  return {
    view(view: 'collapsed' | 'preview'): void {
      state.view = view;
      bus.emit('shell/view-changed', { view });
    },
    dispose(): void { for (const dispose of disposers.reverse()) dispose(); },
  };
}
