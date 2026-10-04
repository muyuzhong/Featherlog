import questManifest from '@featherlog/plugin-quest/manifest.json';
import { setup as questSetup } from '@featherlog/plugin-quest/main';
import scribeManifest from '@featherlog/plugin-scribe/manifest.json';
import { setup as scribeSetup } from '@featherlog/plugin-scribe/main';
import type { MainPlugin } from '@featherlog/kernel';

export const plugins: MainPlugin[] = [
  { manifest: questManifest, setup: questSetup },
  { manifest: scribeManifest, setup: scribeSetup },
];
