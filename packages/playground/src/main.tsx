import type { Badge, PluginManifest, UiContext } from '@featherlog/contracts';
import questManifest from '@featherlog/plugin-quest/manifest.json';
import { setup as setupQuestUi } from '@featherlog/plugin-quest/ui';
import { applyTheme, createSlotRegistry, createUiBus } from '@featherlog/shell/renderer';
import { createRoot } from 'react-dom/client';
import { Desktop } from './Desktop';
import { createMockKernel } from './mock/kernel';
import { createQuestService } from './mock/quest-service';
import { loadPreference } from './preferences';
import { createValue } from './value';
import './playground.css';

applyTheme({ paper: loadPreference('paper', 'vellum'), titleScript: loadPreference('title', 'brush') });

const kernel = createMockKernel();
const registry = createSlotRegistry();
const badges = createValue<Record<string, Badge | null>>({});
const panel = createValue<{ open: boolean; tab: string }>({ open: false, tab: 'quest/journal' });

// The shell's side of the bus, as the Electron main process would provide it.
kernel.handle('shell/set-badge', (payload) => {
  const { iconId, badge } = payload as { iconId: string; badge: Badge | null };
  badges.set({ ...badges.get(), [iconId]: badge });
  return null;
});
kernel.handle('shell/open-panel', (payload) => {
  const { tab } = payload as { tab?: string };
  panel.set({ open: true, tab: tab ?? panel.get().tab });
  return null;
});
kernel.handle('shell/notify', () => null);

// Stand-in for the quest plugin's main half until the real one lands.
const quests = createQuestService(kernel, {
  setBadge: (badge) => badges.set({ ...badges.get(), 'quest/tracker': badge }),
});

// The quest plugin's renderer half, loaded the way the shell would load it.
const manifests = [questManifest as PluginManifest];
const context = (pluginId: string): UiContext => ({
  pluginId,
  bus: createUiBus(kernel.transport(), pluginId),
  slots: registry.providerFor(pluginId),
  settings: { get: () => undefined, onChange: () => () => {} },
  log: console,
  onDispose: () => {},
});
setupQuestUi(context('quest'));

createRoot(document.getElementById('root')!).render(
  <Desktop registry={registry} manifests={manifests} badges={badges} panel={panel} kernel={kernel} onNextDay={quests.nextDay} />,
);
