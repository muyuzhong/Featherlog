import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function startupReady(log) {
  if (/kernel\/plugin-failed|Startup failed|Shutdown failed|Page failed|Preload .*Error/.test(log)) {
    throw new Error(`AppImage reported a startup or shutdown failure\n${log}`);
  }
  return ['quest', 'scribe', 'notes'].every(id =>
    new RegExp(`kernel/plugin-loaded \\{ pluginId: '${id}'[, }]`).test(log)) &&
    /kernel\/ready/.test(log) && /Collapsed window ready/.test(log);
}

export function isolatedEnv(root, env = process.env) {
  const { GH_TOKEN, GITHUB_TOKEN, NODE_OPTIONS, ELECTRON_RUN_AS_NODE, ...rest } = env;
  return { ...rest, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
    XDG_RUNTIME_DIR: join(root, 'runtime'), TMPDIR: join(root, 'tmp'),
    WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: '', ELECTRON_RENDERER_URL: '',
    FEATHERLOG_COMPAT_MODE: '1' };
}

async function inspectorQuit(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Cannot find AppImage main-process inspector');
  const [target] = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Normal quit timed out')); }, 5000);
    const finish = error => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(); };
    socket.addEventListener('error', () => finish(new Error('Inspector connection failed')), { once: true });
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: "process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.quit()",
    } })));
    socket.addEventListener('message', event => {
      const reply = JSON.parse(String(event.data));
      if (reply.id === 1) finish(reply.error || reply.result?.exceptionDetails ? new Error('app.quit() failed') : undefined);
    });
  });
}

export async function smoke(image, { timeoutMs = 60_000, launch = spawn, quit = inspectorQuit } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'featherlog-smoke-'));
  let child;
  try {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const env = isolatedEnv(root);
    for (const directory of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR']) {
      await mkdir(env[directory], { mode: 0o700 });
    }
    child = launch('xvfb-run', ['-a', resolve(image), '--appimage-extract-and-run',
      '--no-sandbox', '--disable-gpu', '--ozone-platform=x11', `--inspect=127.0.0.1:${port}`], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    let exited = false;
    let status;
    let failure;
    child.once('error', error => { failure = error; exited = true; });
    child.once('exit', (code, signal) => { status = { code, signal }; exited = true; });
    const deadline = Date.now() + timeoutMs;
    const logFile = join(env.XDG_CONFIG_HOME, 'Featherlog', 'logs', 'main.log');
    let log = '';
    while (true) {
      log = await readFile(logFile, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      if (exited) throw failure ?? new Error(`AppImage exited before readiness: ${JSON.stringify(status)}\n${output}`);
      if (startupReady(log)) break;
      if (Date.now() >= deadline) throw new Error(`AppImage readiness timed out\n${log}\n${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await quit(port);
    while (!exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (failure || !exited || status?.code !== 0 || status.signal !== null) {
      throw failure ?? new Error(`AppImage did not exit normally: ${JSON.stringify(status)}\n${output}`);
    }
    log = await readFile(logFile, 'utf8'); startupReady(log);
    for (const id of ['scribe', 'notes', 'quest']) {
      if (!new RegExp(`kernel/plugin-unloaded \\{ pluginId: '${id}'[, }]`).test(log)) {
        throw new Error(`AppImage did not cleanly unload ${id}\n${log}`);
      }
    }
    console.log(log);
    console.log('AppImage smoke passed: kernel, quest, scribe, notes, window and normal shutdown');
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node .github/scripts/smoke.mjs <AppImage>');
  await smoke(process.argv[2]);
}
