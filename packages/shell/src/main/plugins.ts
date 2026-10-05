import questManifest from '@featherlog/plugin-quest/manifest.json';
import { setup as questSetup } from '@featherlog/plugin-quest/main';
import notesManifest from '@featherlog/plugin-notes/manifest.json';
import { setup as notesSetup } from '@featherlog/plugin-notes/main';
import scribeManifest from '@featherlog/plugin-scribe/manifest.json';
import { setup as scribeSetup } from '@featherlog/plugin-scribe/main';
import characterManifest from '@featherlog/plugin-character/manifest.json';
import { setup as characterSetup } from '@featherlog/plugin-character/main';
import type { MainPlugin } from '@featherlog/kernel';

export const plugins: MainPlugin[] = [
  { manifest: questManifest, setup: questSetup },
  { manifest: notesManifest, setup: notesSetup },
  { manifest: scribeManifest, setup: scribeSetup },
  { manifest: characterManifest, setup: characterSetup },
];
