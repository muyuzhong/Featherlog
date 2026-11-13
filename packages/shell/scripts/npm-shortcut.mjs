import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

function desktopValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

export async function installShortcut(directory) {
  // shortcut: npx cache paths expire when cleared; rerun npx to refresh the entry.
  const launcher = join(directory, 'bin', 'featherlog.mjs');
  if (process.platform === 'win32') {
    const quote = value => `'${value.replace(/'/g, "''")}'`;
    const launch = Buffer.from(`& ${quote(process.execPath)} ${quote(launcher)}; exit $LASTEXITCODE`, 'utf16le').toString('base64');
    const script = `
$ErrorActionPreference = 'Stop'
$assets = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Featherlog-npm'
New-Item -ItemType Directory -Force -Path $assets | Out-Null
$icon = Join-Path $assets 'icon.ico'
Copy-Item -LiteralPath ${quote(join(directory, 'resources', 'icon.ico'))} -Destination $icon -Force
$programs = [Environment]::GetFolderPath('Programs')
New-Item -ItemType Directory -Force -Path $programs | Out-Null
$path = Join-Path $programs 'Featherlog (npm).lnk'
$link = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
$link.TargetPath = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$link.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${launch}'
$link.IconLocation = $icon + ',0'
$link.Description = 'Featherlog personal quest journal'
$link.Save()
Write-Output $path
`;
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8' }).trim();
  }
  if (process.platform === 'darwin') {
    const bundle = join(homedir(), 'Applications', 'Featherlog (npm).app');
    const contents = join(bundle, 'Contents');
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await mkdir(join(contents, 'Resources'), { recursive: true });
    await copyFile(join(directory, 'resources', 'icon.icns'), join(contents, 'Resources', 'icon.icns'));
    const command = [process.execPath, launcher].map(value => `'${value.replace(/'/g, "'\\''")}'`).join(' ');
    const executable = join(contents, 'MacOS', 'featherlog');
    await writeFile(executable, `#!/bin/sh\nexec ${command} "$@"\n`);
    await chmod(executable, 0o755);
    await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.muyuzhong.featherlog.npm</string>
<key>CFBundleName</key><string>Featherlog (npm)</string>
<key>CFBundleDisplayName</key><string>羽记（npm）</string>
<key>CFBundleExecutable</key><string>featherlog</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`);
    return bundle;
  }
  if (process.platform !== 'linux') return;
  const data = isAbsolute(process.env.XDG_DATA_HOME || '')
    ? process.env.XDG_DATA_HOME : join(homedir(), '.local', 'share');
  const applications = join(data, 'applications');
  const assets = join(data, 'featherlog-npm');
  await mkdir(applications, { recursive: true });
  await mkdir(assets, { recursive: true });
  const icon = join(assets, 'icon.png');
  await copyFile(join(directory, 'resources', 'icon.png'), icon);
  const command = [process.execPath, launcher]
    .map(value => `"${value.replace(/["`$\\]/g, '\\$&').replace(/%/g, '%%')}"`).join(' ');
  const entry = [
    '[Desktop Entry]', 'Type=Application', 'Name=羽记（npm）', 'Name[en]=Featherlog (npm)',
    'Comment=Personal quest journal', `Exec=${desktopValue(command)}`, `Icon=${desktopValue(icon)}`,
    'Terminal=false', 'Categories=Office;', 'StartupWMClass=featherlog', '',
  ].join('\n');
  const path = join(applications, 'featherlog-npm.desktop');
  await writeFile(path, entry, { mode: 0o644 });
  return path;
}
