import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launch } from './browser.mjs';
import { render } from './render.mjs';
import { CAMERA_MS, shoot } from './scenes.mjs';

/*
 * Records the README's promo film from the playground:
 *   pnpm --filter @featherlog/playground promo [--keep]
 * Writes docs/images/promo.mp4 and docs/images/promo.webp. Needs Chrome, ffmpeg and ImageMagick 7.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const work = join(here, 'out');
const WIDTH = 1440;
const HEIGHT = 900;
// Captured at 2x so post-production can zoom in without blurring.
const SCALE = 2;
// The open journal renders well below real time at 2x; a slower page clock keeps every move smooth.
const SLOWDOWN = 6;

const icon = 'data:image/png;base64,' + readFileSync(join(repo, 'packages/shell/resources/icon.png')).toString('base64');
const server = await createServer({
  root: resolve(here, '..'),
  configFile: resolve(here, '../vite.config.ts'),
  logLevel: 'warn',
  server: { host: '127.0.0.1', port: 5190, strictPort: false },
});
await server.listen();
const url = server.resolvedUrls.local[0];

const framesDir = join(work, 'frames');
const page = await launch({ width: WIDTH, height: HEIGHT, scale: SCALE, framesDir });
try {
  await shoot(page, { url, width: WIDTH, height: HEIGHT, icon, slowdown: SLOWDOWN });
} finally {
  page.close();
  await server.close();
}

const { seconds } = await render({
  framesDir,
  renderDir: join(work, 'render'),
  width: WIDTH,
  height: HEIGHT,
  cameraMs: CAMERA_MS,
  mp4: join(repo, 'docs/images/promo.mp4'),
  webp: join(repo, 'docs/images/promo.webp'),
});
if (!process.argv.includes('--keep')) rmSync(work, { recursive: true, force: true });
console.log(`promo: ${seconds.toFixed(1)} s → docs/images/promo.mp4, docs/images/promo.webp`);
