import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

/*
 * Post-production: back to page time, the camera moves, then the two files the README uses.
 * Each output frame is one ImageMagick call on one captured frame; a few run at a time,
 * each with a small memory cap, so a long film never needs much RAM.
 */

const FPS = 30;
const ease = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a, b, u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u });

/** The crop at page time `t`, given camera marks `[{ t, crop }]` that each glide for `ms`. */
export function cameraAt(t, marks, full, ms) {
  let from = full;
  let to = full;
  let start = -Infinity;
  for (const mark of marks) {
    if (mark.t > t) break;
    from = start === -Infinity ? full : lerp(from, to, ease(Math.min(1, (mark.t - start) / (ms / 1000))));
    to = mark.crop;
    start = mark.t;
  }
  return start === -Infinity ? full : lerp(from, to, ease(Math.min(1, (t - start) / (ms / 1000))));
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

async function pool(jobs, size) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < jobs.length) await jobs[next++]();
  }));
}

export async function render({ framesDir, renderDir, width, height, cameraMs, outWidth = 1920, mp4, webp }) {
  const { frames, marks, k, scale } = JSON.parse(readFileSync(join(framesDir, 'frames.json'), 'utf8'));
  if (!frames.length) throw new Error('No frames were recorded');
  const t0 = frames[0].t;
  const times = frames.map((f) => (f.t - t0) / k);
  const cameraMarks = marks.filter((m) => m.label === 'camera').map((m) => ({ t: (m.t - t0) / k, crop: m.data }));
  const full = { x: 0, y: 0, w: width, h: height };
  const outHeight = Math.round((outWidth * height) / width);

  rmSync(renderDir, { recursive: true, force: true });
  mkdirSync(renderDir, { recursive: true });
  const count = Math.floor((times.at(-1) + 0.4) * FPS);
  const jobs = [];
  let source = 0;
  for (let i = 0; i < count; i++) {
    const t = i / FPS;
    while (source + 1 < times.length && times[source + 1] <= t) source++;
    const crop = cameraAt(t, cameraMarks, full, cameraMs);
    const input = frames[source].file;
    const output = join(renderDir, `${String(i).padStart(5, '0')}.jpg`);
    const limits = ['-limit', 'memory', '256MiB', '-limit', 'map', '512MiB'];
    const args = crop.w >= width - 0.5
      ? [...limits, input, '-filter', 'Lanczos', '-resize', `${outWidth}x${outHeight}!`, '-quality', '93', output]
      : [...limits, input, '-virtual-pixel', 'edge', '-set', 'option:distort:viewport', `${outWidth}x${outHeight}+0+0`,
          '-filter', 'Lanczos', '-distort', 'SRT', `${crop.x * scale},${crop.y * scale},${outWidth / (crop.w * scale)},0,0,0`,
          '+repage', '-quality', '93', output];
    jobs.push(() => run('magick', args));
  }
  await pool(jobs, Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2))));

  await run('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(renderDir, '%05d.jpg'),
    '-c:v', 'libx264', '-crf', '23', '-preset', 'veryslow', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  // The README shows a silent, looping preview; 1280 wide at 20 fps keeps it near 3–4 MB.
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf', 'fps=20,scale=1280:-1:flags=lanczos',
    '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '70', '-compression_level', '6', '-loop', '0', webp]);
  return { seconds: count / FPS };
}
