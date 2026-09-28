import manifest from '@featherlog/plugin-quest/manifest.json';
import { setup } from '@featherlog/plugin-quest/main';
import type { MainPlugin } from '@featherlog/kernel';

export const plugins: MainPlugin[] = [{ manifest, setup }];
