import type { MainContext, PluginManifest } from '@featherlog/contracts';
import { createKernel, type MainPlugin } from '@featherlog/kernel';
import questManifest from '@featherlog/plugin-quest/manifest.json';
import { setup as questMain } from '@featherlog/plugin-quest/main';
import { setup as questUi } from '@featherlog/plugin-quest/ui';
import { applyTheme, setPaper, type Paper } from '@featherlog/shell/renderer';
import { createRuntime, type UiPlugin } from '@featherlog/shell/renderer/app';
import { createRoot } from 'react-dom/client';
import { Desktop } from './Desktop';
import { createDevClock, periodKey } from './host/clock';
import { clearAll } from './host/persist';
import { createFakePreload } from './host/preload';
import { seedJournal } from './host/seed';
import { createSettings } from './host/settings';
import { createHostShell } from './host/shell';
import { createStorage } from './host/storage';
import './playground.css';

/*
 * The playground plays the Electron main process in the browser: the real kernel
 * and the real quest plugin, a stand-in for the shell's main half, and one fake
 * preload per simulated window. The window UIs are the real ones (design §6).
 */
const manifest = questManifest as PluginManifest;
const mainPlugins: MainPlugin[] = [{ manifest, setup: questMain as (ctx: MainContext) => Promise<void> }];
const uiPlugins: UiPlugin[] = [{ manifest, setup: questUi }];

const settings = createSettings([manifest]);
const { clock, nextDay } = createDevClock();
const log = { debug: console.debug, info: console.info, warn: console.warn, error: console.error };
const kernel = createKernel({
  development: true,
  clock,
  log,
  createServices: (pluginId) => ({ storage: createStorage(pluginId), settings: settings.forPlugin(pluginId), clock, log }),
});
const shell = createHostShell(kernel);
const busLog = { entries: [] as import('@featherlog/contracts').Envelope[] };
kernel.observe((envelope) => {
  busLog.entries.push(envelope);
  if (busLog.entries.length > 400) busLog.entries.shift();
});

applyTheme({ paper: (settings.all().shell?.paper as Paper | undefined) ?? 'vellum' });
settings.onChange((scope, key, value) => scope === 'shell' && key === 'paper' && setPaper(value as Paper));

await kernel.load(mainPlugins);
const dayStartHour = () => Number(settings.all().quest?.dayStartHour ?? 4);
await seedJournal(shell.bus, (plus = 0) => periodKey(clock.now(), dayStartHour(), plus));

// The dock's native context menu (design §6.4), drawn by the Desktop.
const menuListeners = new Set<() => void>();
const menu = {
  open: () => menuListeners.forEach((listener) => listener()),
  onOpen(listener: () => void) {
    menuListeners.add(listener);
    return () => void menuListeners.delete(listener);
  },
};
const [collapsed, panel] = await Promise.all([
  createRuntime(createFakePreload('collapsed', kernel, shell, settings, menu.open), uiPlugins),
  createRuntime(createFakePreload('panel', kernel, shell, settings, menu.open), uiPlugins),
]);

createRoot(document.getElementById('root')!).render(
  <Desktop
    shell={shell}
    settings={settings}
    collapsed={collapsed}
    panel={panel}
    busLog={busLog}
    kernel={kernel}
    menu={menu}
    onNextDay={() => {
      nextDay();
      // The quest plugin notices the new period on its next request (design §8.5).
      void shell.bus.request('quest/list', {});
    }}
    onReset={() => {
      clearAll();
      location.reload();
    }}
  />,
);
