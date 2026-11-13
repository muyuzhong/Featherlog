import assert from 'node:assert/strict';
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const shell = fileURLToPath(new URL('../', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const destination = join(root, 'dist', 'npm');
const require = createRequire(import.meta.url);
const source = JSON.parse(await readFile(join(shell, 'package.json'), 'utf8'));
const electron = require('electron/package.json');
for (const entry of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
  assert((await stat(join(shell, entry))).isFile(), `Missing build output: ${entry}`);
}
await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, 'bin'), { recursive: true });
await cp(join(shell, 'out'), join(destination, 'out'), {
  recursive: true, filter: path => !path.endsWith('.map') && !path.endsWith('.woff'),
});
await cp(join(shell, 'scripts/npm-cli.mjs'), join(destination, 'bin/featherlog.mjs'));
await cp(join(shell, 'scripts/npm-shortcut.mjs'), join(destination, 'bin/npm-shortcut.mjs'));
await chmod(join(destination, 'bin/featherlog.mjs'), 0o755);
await mkdir(join(destination, 'resources'));
for (const extension of ['png', 'ico', 'icns']) {
  await cp(join(shell, `resources/icon.${extension}`), join(destination, `resources/icon.${extension}`));
}
await cp(join(root, 'LICENSE'), join(destination, 'LICENSE'));
await mkdir(join(destination, 'licenses'));
for (const [name, dependency] of [['xiaolai', '@chinese-fonts/xiaolai'], ['ma-shan-zheng', '@fontsource/ma-shan-zheng']]) {
  await cp(join(shell, 'node_modules', dependency, 'LICENSE'), join(destination, 'licenses', `${name}.txt`));
}
await cp(join(shell, 'scripts/npm-README.md'), join(destination, 'README.md'));
const manifest = {
  name: 'featherlog-app', version: source.version, description: source.description,
  author: source.author, license: 'MIT', type: 'module', main: source.main,
  bin: { featherlog: 'bin/featherlog.mjs' },
  files: ['bin/', 'out/', 'licenses/', 'resources/'],
  engines: electron.engines,
  repository: { type: 'git', url: 'git+https://github.com/muyuzhong/Featherlog.git' },
  homepage: 'https://github.com/muyuzhong/Featherlog#readme',
  bugs: { url: 'https://github.com/muyuzhong/Featherlog/issues' },
  dependencies: { ...source.dependencies, electron: electron.version },
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
};
assert(Object.values(manifest.dependencies).every(version => !version.startsWith('workspace:')));
await writeFile(join(destination, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared ${manifest.name}@${manifest.version} in ${destination}`);
