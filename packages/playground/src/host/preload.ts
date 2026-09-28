import type { Envelope, FeatherlogPreload, WindowKind } from '@featherlog/contracts';
import type { Kernel } from '@featherlog/kernel';
import type { SettingsHost } from './settings';
import type { HostShell } from './shell';

/**
 * A stand-in for one window's preload script, with the IPC bridge semantics of
 * design §6.3: per-window subscriptions, responses only to the requesting window,
 * and asynchronous delivery as over real IPC.
 */
export function createFakePreload(
  kind: WindowKind,
  kernel: Kernel,
  shell: HostShell,
  settings: SettingsHost,
  onMenu: () => void,
): FeatherlogPreload {
  const subscribed = new Set<string>();
  const awaiting = new Set<string>();
  const listeners = new Set<(envelope: Envelope) => void>();

  kernel.observe((envelope) => {
    const wanted =
      (envelope.kind === 'event' && subscribed.has(envelope.type)) ||
      (envelope.kind === 'response' && envelope.replyTo !== undefined && awaiting.delete(envelope.replyTo));
    if (!wanted) return;
    const copy = structuredClone(envelope);
    setTimeout(() => listeners.forEach((listener) => listener(copy)), 0);
  });

  return {
    window: { kind },
    bus: {
      send(envelope) {
        if (envelope.kind === 'request') awaiting.add(envelope.id);
        kernel.inject(structuredClone(envelope));
      },
      onDeliver(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribe: (types) => types.forEach((type) => subscribed.add(type)),
      unsubscribe: (types) => types.forEach((type) => subscribed.delete(type)),
    },
    settings: {
      all: async () => settings.all(),
      set: async (scope, key, value) => settings.set(scope, key, value),
      onChange: (listener) => settings.onChange(listener),
    },
    dock: {
      resize: (size) => shell.resizeDock(size),
      menu: onMenu,
      side: async () => shell.side(),
      onSide: (listener) => shell.onSide((side) => setTimeout(() => listener(side), 0)),
    },
    panel: {
      close: () => shell.closePanel(),
    },
    platform: { os: 'linux', dock: { anchored: false, keepAbove: true, focusSafe: true } },
  };
}
