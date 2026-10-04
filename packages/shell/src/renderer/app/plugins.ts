import type { PluginManifest } from '@featherlog/contracts';
import questManifest from '@featherlog/plugin-quest/manifest.json';
import { setup as questUi } from '@featherlog/plugin-quest/ui';
import scribeManifest from '@featherlog/plugin-scribe/manifest.json';
import { setup as scribeUi } from '@featherlog/plugin-scribe/ui';
import type { UiPlugin } from './runtime';

/**
 * Composition root of the renderer (design §6.1): the only place, together with
 * src/main/plugins.ts, allowed to import plugin packages.
 */
export const uiPlugins: UiPlugin[] = [
  { manifest: questManifest as PluginManifest, setup: questUi },
  { manifest: scribeManifest as PluginManifest, setup: scribeUi },
];
