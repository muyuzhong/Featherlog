import type { Envelope, FeatherlogPreload, PluginManifest, PluginSecrets, WindowKind } from '@featherlog/contracts';
import type { Kernel } from '@featherlog/kernel';
import type { SettingsHost } from './settings';
import type { HostShell } from './shell';

// ponytail: memory-only playground secrets; Electron owns encryption and persistence.
const secretValues = new Map<string, Map<string, string>>();
const secretListeners = new Set<(scope: string, key: string) => void>();

export function secretsForPlugin(scope: string): PluginSecrets {
  return {
    get: async key => secretValues.get(scope)?.get(key),
    onChange(listener) {
      const callback = (changed: string, key: string) => { if (changed === scope) listener(key); };
      secretListeners.add(callback);
      return () => { secretListeners.delete(callback); };
    },
  };
}

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
  manifests: readonly PluginManifest[],
): FeatherlogPreload {
  const subscribed = new Set<string>();
  const awaiting = new Set<string>();
  const listeners = new Set<(envelope: Envelope) => void>();
  const validateSecret = (scope: string, key: string) => {
    const schema = manifests.find(manifest => manifest.id === scope)?.contributes?.settings?.schema as
      { properties?: Record<string, { type?: string; writeOnly?: boolean }> } | undefined;
    const property = schema?.properties?.[key];
    if (property?.type !== 'string' || property.writeOnly !== true) {
      throw Object.assign(new Error('Only write-only string settings can store secrets'), {
        code: 'shell/invalid-setting',
      });
    }
  };

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
      async setSecret(scope, key, value) {
        validateSecret(scope, key);
        let values = secretValues.get(scope);
        if (!values) { values = new Map(); secretValues.set(scope, values); }
        if (value === '') values.delete(key);
        else values.set(key, value);
        secretListeners.forEach(listener => listener(scope, key));
      },
      async hasSecret(scope, key) {
        validateSecret(scope, key);
        return secretValues.get(scope)?.has(key) ?? false;
      },
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
