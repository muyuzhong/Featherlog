#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installShortcut } from './npm-shortcut.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
} else if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npx featherlog-app [Electron options]\nLaunch the Featherlog desktop journal. Update with npx featherlog-app@latest.\nAdds a Featherlog (npm) launcher to the Linux application menu, Windows Start menu, or macOS ~/Applications.');
} else {
  try {
    await installShortcut(directory);
  } catch (error) {
    console.warn(`featherlog/shortcut-failed: ${error.message}`);
  }
  const require = createRequire(import.meta.url);
  const env = { ...process.env, FEATHERLOG_NPM: '1' };
  // A dev server or Node-only Electron mode must not replace the published app.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const child = spawn(process.execPath, [require.resolve('electron/cli.js'), directory, ...args],
    { stdio: 'inherit', env });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  child.once('error', error => {
    console.error(`featherlog/launch-failed: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
  });
}
