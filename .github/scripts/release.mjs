import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' });

export function expectedAssets(version) {
  const prefix = `Featherlog-${version}`;
  const installers = [`${prefix}-x64.exe`];
  for (const arch of ['arm64', 'x64']) {
    installers.push(`${prefix}-${arch}.dmg`);
  }
  return [
    `${prefix}-x86_64.AppImage`,
    ...installers.flatMap(name => [name, `${name}.blockmap`]),
    'latest.yml', 'latest-linux.yml', 'latest-mac.yml',
  ].sort();
}

export function releaseTask(command, { version, tag, repo, id }, run = gh) {
  if (tag !== `v${version}`) throw new Error(`Tag ${tag} does not match v${version}`);
  if (!['prepare', 'check', 'verify'].includes(command)) throw new Error('Unknown release task');
  const api = endpoint => JSON.parse(run('api', '--paginate', '--slurp', endpoint)).flat();
  const find = () => {
    const matches = api(`repos/${repo}/releases`).filter(release => release.tag_name === tag);
    if (matches.length > 1) throw new Error(`Multiple releases for ${tag}; resolve them manually`);
    if (matches[0] && !matches[0].draft) throw new Error(`${tag} is already published`);
    return matches[0];
  };
  let release = find();
  if (!release && command === 'prepare') {
    release = JSON.parse(run('api', '-X', 'POST', `repos/${repo}/releases`,
      '-f', `tag_name=${tag}`, '-f', `name=${tag}`, '-F', 'draft=true'));
  }
  if (!release) throw new Error(`Draft ${tag} does not exist`);
  if (command !== 'prepare' && String(release.id) !== id) {
    throw new Error(`Draft changed: expected ${id}, found ${release.id}`);
  }
  if (command === 'check') {
    // electron-publish only searches the first page; never silently skip an older draft.
    const visible = JSON.parse(run('api', `repos/${repo}/releases`));
    if (!visible.some(item => item.id === release.id)) {
      throw new Error(`Draft ${release.id} is outside the publisher's first page`);
    }
  }
  if (command === 'verify') {
    const assets = api(`repos/${repo}/releases/${release.id}/assets`);
    const expected = expectedAssets(version);
    const names = assets.map(asset => asset.name);
    const missing = expected.filter(name => !names.includes(name));
    const extra = names.filter(name => !expected.includes(name));
    const duplicate = names.filter((name, index) => names.indexOf(name) !== index);
    const incomplete = assets.filter(asset => asset.state !== 'uploaded' || asset.size <= 0);
    if (missing.length || extra.length || duplicate.length || incomplete.length) {
      throw new Error(JSON.stringify({ missing, extra, duplicate,
        incomplete: incomplete.map(asset => asset.name) }));
    }
  }
  return String(release.id);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(readFileSync('packages/shell/package.json', 'utf8'));
  const id = releaseTask(process.argv[2], {
    version, tag: process.env.GITHUB_REF_NAME, repo: process.env.GITHUB_REPOSITORY,
    id: process.env.RELEASE_ID,
  });
  if (process.argv[2] === 'prepare' && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `release_id=${id}\n`);
  }
  console.log(`Draft ${id}: ${process.argv[2]} succeeded`);
}
