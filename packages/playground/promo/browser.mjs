import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Headless Chrome over the DevTools protocol, recording the page with screencast.
 *
 * Heavy frames (the open journal at 2x) render far slower than real time, so while
 * recording the page's clock runs `k` times slower: timers, rAF timestamps,
 * performance.now and the animation timeline all stretch together. Frames are kept
 * with their real timestamps; dividing by `k` gives the page's own time back.
 */

const DILATE = `(() => {
  const realNow = performance.now.bind(performance);
  const dateBase = Date.now();
  const nowBase = realNow();
  let k = 1, realAt = nowBase, pageAt = nowBase;
  const now = () => pageAt + (realNow() - realAt) / k;
  performance.now = now;
  Date.now = () => dateBase + (now() - nowBase);
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf(() => cb(now()));
  const later = window.setTimeout.bind(window);
  const every = window.setInterval.bind(window);
  window.setTimeout = (fn, ms = 0, ...rest) => later(fn, ms * k, ...rest);
  window.setInterval = (fn, ms = 0, ...rest) => every(fn, ms * k, ...rest);
  window.__dilate = (next) => { pageAt = now(); realAt = realNow(); k = next; };
})()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findChrome() {
  const names = [process.env.CHROME, 'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'].filter(Boolean);
  const found = names.find((name) => spawnSync('which', [name]).status === 0);
  if (!found) throw new Error('Chrome not found; set CHROME to its executable');
  return found;
}

/** Frames are saved at most this often in page time; more only fills the disk. */
const FRAMES_PER_PAGE_SECOND = 45;

export async function launch({ width, height, scale, framesDir, port = 9334 }) {
  const profile = mkdtempSync(join(tmpdir(), 'featherlog-promo-'));
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  const chrome = spawn(findChrome(), [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars',
    '--no-first-run', `--force-device-scale-factor=${scale}`, `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' });

  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(200); }
  }
  if (!targets) throw new Error('Chrome did not open its debugging port');
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

  let seq = 0;
  let k = 1;
  let recording = false;
  const pending = new Map();
  const frames = [];
  const marks = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
    if (msg.method === 'Page.screencastFrame') {
      const { data, metadata, sessionId } = msg.params;
      ws.send(JSON.stringify({ id: ++seq, method: 'Page.screencastFrameAck', params: { sessionId } }));
      const last = frames.at(-1);
      if (recording && (!last || metadata.timestamp - last.t >= k / FRAMES_PER_PAGE_SECOND)) {
        const file = join(framesDir, `${String(frames.length).padStart(5, '0')}.jpg`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        frames.push({ file, t: metadata.timestamp });
      }
    }
    if (msg.method === 'Runtime.exceptionThrown') console.error('page error:', msg.params.exceptionDetails.exception?.description);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Animation.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: DILATE });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });

  return {
    send,
    /** Waits in page time. */
    sleep: (ms) => sleep(ms * k),
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async goto(url) {
      await send('Page.navigate', { url });
      await sleep(2500);
    },
    async slowDown(next) {
      await send('Runtime.evaluate', { expression: `window.__dilate(${next})` });
      await send('Animation.setPlaybackRate', { playbackRate: 1 / next });
      k = next;
    },
    async startRecording() {
      await send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: width * scale, maxHeight: height * scale });
      recording = true;
    },
    async stopRecording() {
      recording = false;
      await send('Page.stopScreencast');
    },
    /** Notes a moment (and what happens there) for post-production. */
    mark(label, data) {
      marks.push({ label, data, t: Date.now() / 1000 });
    },
    close() {
      writeFileSync(join(framesDir, 'frames.json'), JSON.stringify({ frames, marks, k, scale }));
      ws.close();
      chrome.kill();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
