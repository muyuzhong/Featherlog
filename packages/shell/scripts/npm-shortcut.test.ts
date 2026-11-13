import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { installShortcut } from './npm-shortcut.mjs';

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFileSync,
}));
const node = process.execPath;
const platform = process.platform;
const home = vi.hoisted(() => ({ directory: '' }));
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), homedir: () => home.directory,
}));
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  execFileSync.mockReset();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'featherlog-shortcut-'));
  directories.push(root);
  home.directory = root;
  vi.stubGlobal('process', { ...process, platform: 'linux', execPath: '/opt/node/bin/node' });
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  const app = join(root, 'npm cache', 'featherlog-app');
  await mkdir(join(app, 'resources'), { recursive: true });
  await writeFile(join(app, 'resources', 'icon.png'), 'image');
  await writeFile(join(app, 'resources', 'icon.icns'), 'mac image');
  return { root, app, data: join(root, 'data') };
}

it('creates a menu entry and persistent icon without overwriting the installed app entry', async () => {
  const { app, data } = await fixture();
  await mkdir(join(data, 'applications'), { recursive: true });
  await writeFile(join(data, 'applications', 'featherlog.desktop'), 'existing AppImage');
  const path = await installShortcut(app);
  const entry = await readFile(path, 'utf8');
  expect(path).toBe(join(data, 'applications', 'featherlog-npm.desktop'));
  expect(entry).toContain('Name=羽记（npm）\n');
  expect(entry).toContain(`Exec="/opt/node/bin/node" "${join(app, 'bin', 'featherlog.mjs').replaceAll('\\', '\\\\\\\\')}"\n`);
  expect(entry).toContain(`Icon=${join(data, 'featherlog-npm', 'icon.png').replaceAll('\\', '\\\\')}\n`);
  expect(entry).toContain('Terminal=false\n');
  expect(await readFile(join(data, 'featherlog-npm', 'icon.png'), 'utf8')).toBe('image');
  expect(await readFile(join(data, 'applications', 'featherlog.desktop'), 'utf8')).toBe('existing AppImage');
  await installShortcut(app);
  expect(await readFile(path, 'utf8')).toBe(entry);
  const upgraded = join(app, 'new-version');
  await mkdir(join(upgraded, 'resources'), { recursive: true });
  await writeFile(join(upgraded, 'resources/icon.png'), 'new image');
  expect(await installShortcut(upgraded)).toBe(path);
  expect(await readFile(path, 'utf8')).toContain(join(upgraded, 'bin', 'featherlog.mjs').replaceAll('\\', '\\\\\\\\'));
  expect(await readdir(join(data, 'applications'))).toEqual(['featherlog-npm.desktop', 'featherlog.desktop']);
});

it.each(['', 'relative/path'])('ignores an unset or relative XDG_DATA_HOME (%s)', async value => {
  const { app, root } = await fixture();
  vi.stubEnv('XDG_DATA_HOME', value);
  expect(await installShortcut(app)).toBe(join(root, '.local/share/applications/featherlog-npm.desktop'));
});

it('escapes Exec field codes, shell metacharacters and desktop value escapes', async () => {
  const { app } = await fixture();
  vi.stubGlobal('process', { ...process, execPath: '/opt/100%/$node`"\\\n\t\r' });
  const entry = await readFile(await installShortcut(app), 'utf8');
  const exec = entry.split('\n').find(line => line.startsWith('Exec='))!;
  expect(exec).toContain('100%%/');
  expect(exec).toContain('\\\\$node\\\\`\\\\"\\\\\\\\\\n\\t\\r');
  expect(entry.split('\n').filter(line => line.startsWith('Exec='))).toHaveLength(1);
});

it('does not change files on unsupported platforms', async () => {
  const { root, app } = await fixture();
  vi.stubGlobal('process', { ...process, platform: 'freebsd' });
  expect(await installShortcut(app)).toBeUndefined();
  expect(await readdir(root)).toEqual(['npm cache']);
});

it('creates a macOS app with an icon and an executable launcher, and updates it in place', async () => {
  const { root, app } = await fixture();
  vi.stubGlobal('process', { ...process, platform: 'darwin', execPath: node });
  const bundle = await installShortcut(app);
  expect(bundle).toBe(join(root, 'Applications', 'Featherlog (npm).app'));
  const contents = join(bundle, 'Contents');
  expect(await readFile(join(contents, 'Resources', 'icon.icns'), 'utf8')).toBe('mac image');
  const plist = await readFile(join(contents, 'Info.plist'), 'utf8');
  expect(plist).toContain('<key>CFBundleExecutable</key><string>featherlog</string>');
  expect(plist).toContain('<key>CFBundleIconFile</key><string>icon.icns</string>');
  const executable = join(contents, 'MacOS', 'featherlog');
  expect(await readFile(executable, 'utf8')).toContain(app);
  if (platform !== 'win32') expect((await stat(executable)).mode & 0o777).toBe(0o755);
  expect(await installShortcut(app)).toBe(bundle);
  expect(await readdir(join(root, 'Applications'))).toEqual(['Featherlog (npm).app']);
});

it.skipIf(platform === 'win32')('runs the macOS launcher with quoted paths and preserves argument boundaries', async () => {
  const { app, root } = await fixture();
  const quoted = join(root, "npm ' $ ` cache");
  await mkdir(join(quoted, 'resources'), { recursive: true });
  await writeFile(join(quoted, 'resources/icon.icns'), 'mac image');
  await mkdir(join(quoted, 'bin'));
  await writeFile(join(quoted, 'bin/featherlog.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  vi.stubGlobal('process', { ...process, platform: 'darwin', execPath: node });
  const bundle = await installShortcut(quoted);
  const result = spawnSync(join(bundle, 'Contents/MacOS/featherlog'), [app, 'one argument', '$(false)'], { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([app, 'one argument', '$(false)']);
});

it('creates a per-user Windows shortcut with a persistent icon and hidden, safely quoted launch command', async () => {
  const { app } = await fixture();
  vi.stubGlobal('process', { ...process, platform: 'win32', execPath: "C:\\User's Node\\node.exe" });
  execFileSync.mockReturnValue('C:\\Start Menu\\Featherlog (npm).lnk\r\n');
  expect(await installShortcut(app)).toBe('C:\\Start Menu\\Featherlog (npm).lnk');
  const [command, args, options] = execFileSync.mock.calls[0]!;
  expect(command).toBe('powershell.exe');
  expect(options.windowsHide).toBe(true);
  expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  expect(script).toContain("$ErrorActionPreference = 'Stop'");
  expect(script).toContain("[Environment]::GetFolderPath('Programs')");
  expect(script).toContain("[Environment]::GetFolderPath('LocalApplicationData')");
  expect(script).toContain("$link.IconLocation = $icon + ',0'");
  const encoded = script.match(/-WindowStyle Hidden -EncodedCommand ([A-Za-z0-9+/=]+)/)![1]!;
  const launch = Buffer.from(encoded, 'base64').toString('utf16le');
  expect(launch).toContain("& 'C:\\User''s Node\\node.exe'");
  expect(launch).toContain(`'${join(app, 'bin', 'featherlog.mjs')}'`);
});

it('reports Windows shortcut creation failures to the CLI', async () => {
  const { app } = await fixture();
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  execFileSync.mockImplementation(() => { throw new Error('PowerShell failed'); });
  await expect(installShortcut(app)).rejects.toThrow('PowerShell failed');
});

it('preserves an existing entry if copying the new icon fails', async () => {
  const { app, data } = await fixture();
  const path = await installShortcut(app);
  const entry = await readFile(path, 'utf8');
  await expect(installShortcut(join(app, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path, 'utf8')).toBe(entry);
  expect(await readFile(join(data, 'featherlog-npm', 'icon.png'), 'utf8')).toBe('image');
});
