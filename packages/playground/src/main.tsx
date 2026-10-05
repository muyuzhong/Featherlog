import type { MainContext, PluginManifest } from '@featherlog/contracts';
import { createKernel, type MainPlugin } from '@featherlog/kernel';
import characterManifest from '@featherlog/plugin-character/manifest.json';
import { setup as characterMain } from '@featherlog/plugin-character/main';
import { setup as characterUi } from '@featherlog/plugin-character/ui';
import questManifest from '@featherlog/plugin-quest/manifest.json';
import notesManifestJson from '@featherlog/plugin-notes/manifest.json';
import { setup as notesMain } from '@featherlog/plugin-notes/main';
import { setup as notesUi } from '@featherlog/plugin-notes/ui';
import scribeManifestJson from '@featherlog/plugin-scribe/manifest.json';
import { setup as scribeUi } from '@featherlog/plugin-scribe/ui';
import { setup as questMain } from '@featherlog/plugin-quest/main';
import { setup as questUi } from '@featherlog/plugin-quest/ui';
import { applyTheme, setPaper, type Paper } from '@featherlog/shell/renderer';
import { createRuntime, type UiPlugin } from '@featherlog/shell/renderer/app';
import { createRoot } from 'react-dom/client';
import { Desktop } from './Desktop';
import { createDevClock, periodKey } from './host/clock';
import { clearAll } from './host/persist';
import { createFakePreload, secretsForPlugin } from './host/preload';
import { seedJournal } from './host/seed';
import { createSettings } from './host/settings';
import { createFakeScribe } from './host/scribe';
import { createHostShell } from './host/shell';
import { createStorage } from './host/storage';
import './playground.css';

/*
 * The playground plays the Electron main process in the browser: the real kernel
 * and the real quest plugin, a stand-in for the shell's main half, and one fake
 * preload per simulated window. The window UIs are the real ones (design §6).
 */
const manifest = questManifest as PluginManifest;
const scribeManifest = scribeManifestJson as PluginManifest;
const notesManifest = notesManifestJson as PluginManifest;
const mainPlugins: MainPlugin[] = [
  { manifest, setup: questMain as (ctx: MainContext) => Promise<void> },
  // The real notes plugin: 手记 and 随笔 are kept in the playground's storage like quests are.
  { manifest: notesManifest, setup: notesMain },
  { manifest: characterManifest, setup: characterMain },
];
const uiPlugins: UiPlugin[] = [
  { manifest, setup: questUi },
  { manifest: scribeManifest, setup: scribeUi },
  { manifest: notesManifest, setup: notesUi },
  { manifest: characterManifest as PluginManifest, setup: characterUi },
];

const settings = createSettings([manifest, scribeManifest, notesManifest]);
const { clock, nextDay } = createDevClock();
const log = { debug: console.debug, info: console.info, warn: console.warn, error: console.error };
const kernel = createKernel({
  development: true,
  clock,
  log,
  createServices: (pluginId) => ({ storage: createStorage(pluginId), settings: settings.forPlugin(pluginId),
    secrets: secretsForPlugin(pluginId), clock, log }),
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
// A few notes to read, only into a fresh playground.
if ((await shell.bus.request('notes/list', { limit: 1 })).notes.length === 0) {
  const { quests } = await shell.bus.request('quest/list', {});
  const memory = quests.find((q) => q.name === '内存之王');
  const notes = [
    { text: '今天在地铁上想到：任务日志最好的地方，是它不催我。' },
    ...(memory
      ? [
          { text: 'RDB 是快照，AOF 是日志。\n快照恢复快、可能丢最后几分钟；日志更完整，但文件会越写越大，所以要重写。', questId: memory.id },
          { text: '读到 everysec：每秒 fsync 一次，是性能和安全之间最常见的折中。', questId: memory.id },
        ]
      : []),
    { text: '想写的随笔：\n· 为什么游戏的任务让人想做完\n· 羊皮纸的颜色到底该有多黄' },
  ];
  for (const input of notes) await shell.bus.request('notes/create', { input });
}
// After seeding, so 翎 only answers what happens in the playground, not the seed's history.
const scribe = createFakeScribe(kernel);

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
  createRuntime(createFakePreload('collapsed', kernel, shell, settings, menu.open, [manifest, scribeManifest, notesManifest]), uiPlugins),
  createRuntime(createFakePreload('panel', kernel, shell, settings, menu.open, [manifest, scribeManifest, notesManifest]), uiPlugins),
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
    scribe={scribe}
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
