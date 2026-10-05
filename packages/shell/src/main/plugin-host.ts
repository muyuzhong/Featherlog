import type { PluginEntry } from '@featherlog/contracts';
import type { Kernel, MainPlugin } from '@featherlog/kernel';
import { invalid, record } from './validation';

type PluginSettings = {
  enabledPlugins(): string[];
  setEnabledPlugins(ids: string[]): Promise<void> | void;
};

/** Shared by the Electron host and its browser playground stand-in. */
export function registerPluginHost(kernel: Kernel, plugins: MainPlugin[], settings: PluginSettings) {
  const bus = kernel.createBus('shell');
  const states = new Map<string, PluginEntry['state']>();
  let enabled = new Set(settings.enabledPlugins());
  let tail = Promise.resolve();
  let stopped = false;
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const job = tail.then(() => {
      if (stopped) invalid('Plugin host is stopped');
      return work();
    });
    tail = job.then(() => {}, () => {});
    return job;
  };
  const list = (): { plugins: PluginEntry[] } => ({ plugins: plugins.map(({ manifest }) => ({
    id: manifest.id, name: manifest.name,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    optional: manifest.optional === true,
    enabled: manifest.optional !== true || enabled.has(manifest.id),
    state: states.get(manifest.id) ?? 'off',
  })) });
  const disposers = [
    // Observe lifecycle synchronously so a completed load is immediately queryable.
    kernel.observe(message => {
      if (message.kind !== 'event' || message.source !== 'kernel' || !record(message.payload)) return;
      const id = message.payload.pluginId;
      if (typeof id !== 'string') return;
      if (message.type === 'kernel/plugin-loaded') states.set(id, 'loaded');
      if (message.type === 'kernel/plugin-failed') states.set(id, 'failed');
      if (message.type === 'kernel/plugin-unloaded') states.set(id, 'off');
    }),
    bus.handle('shell/plugins', () => enqueue(async () => list())),
    bus.handle('shell/set-plugin-enabled', (payload, envelope) => enqueue(async () => {
      if (!record(payload) || typeof payload.pluginId !== 'string' || typeof payload.enabled !== 'boolean') {
        invalid('Expected pluginId and enabled');
      }
      const plugin = plugins.find(plugin => plugin.manifest.id === payload.pluginId);
      if (!plugin || plugin.manifest.optional !== true) invalid('Only known optional plugins can be toggled');
      if (enabled.has(payload.pluginId) === payload.enabled) return list();
      const next = new Set(enabled);
      if (payload.enabled) next.add(payload.pluginId);
      else next.delete(payload.pluginId);
      // Persist intent first: failed setup stays selected, and a failed settings write changes nothing live.
      await settings.setEnabledPlugins([...next]);
      enabled = next;
      if (payload.enabled) await kernel.load([plugin]);
      else {
        kernel.unload(payload.pluginId);
        states.set(payload.pluginId, 'off');
      }
      const result = list();
      bus.emit('shell/plugins-changed', result, { causedBy: envelope.id });
      return result;
    })),
  ];
  return {
    start(load: (selected: MainPlugin[]) => Promise<void> = selected => kernel.load(selected)) {
      return enqueue(() => load(plugins.filter(plugin => plugin.manifest.optional !== true || enabled.has(plugin.manifest.id))));
    },
    async dispose() {
      stopped = true;
      for (const dispose of disposers.reverse()) dispose();
      await tail;
    },
  };
}
