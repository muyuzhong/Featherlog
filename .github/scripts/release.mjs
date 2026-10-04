import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' });

export function versionTag(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Release version must be a stable major.minor.patch');
  }
  return `v${version}`;
}

export function claimTag({ version, repo, sha }, run = gh) {
  const tag = versionTag(version);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Missing immutable commit SHA');
  const refs = JSON.parse(run('api', '--paginate', '--slurp', `repos/${repo}/git/matching-refs/tags/${tag}`)).flat();
  if (refs.some(ref => ref.ref === `refs/tags/${tag}`)) return '';
  // GitHub atomically rejects a competing creation; never overwrite or retry a claimed version.
  run('api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`);
  return tag;
}

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

export function releaseTask(command, { version, tag, repo, id, previousTag }, run = gh) {
  if (tag !== versionTag(version)) throw new Error(`Tag ${tag} does not match v${version}`);
  if (!['prepare', 'check', 'verify', 'publish'].includes(command)) throw new Error('Unknown release task');
  const api = endpoint => JSON.parse(run('api', '--paginate', '--slurp', endpoint)).flat();
  const find = () => {
    const matches = api(`repos/${repo}/releases`).filter(release => release.tag_name === tag);
    if (matches.length > 1) throw new Error(`Multiple releases for ${tag}; resolve them manually`);
    if (matches[0] && !matches[0].draft) throw new Error(`${tag} is already published`);
    return matches[0];
  };
  let release = find();
  if (!release && command === 'prepare') {
    // Both workflow paths already have the tag; target_commitish only accepts a branch or SHA.
    release = JSON.parse(run('api', '-X', 'POST', `repos/${repo}/releases`,
      '-f', `tag_name=${tag}`, '-f', `name=${tag}`, '-F', 'draft=true',
      '-F', 'generate_release_notes=true'));
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
  if (command === 'verify' || command === 'publish') {
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
  if (command === 'publish') {
    if (release.prerelease) throw new Error(`${tag} is a prerelease`);
    const notes = JSON.parse(run('api', '-X', 'POST', `repos/${repo}/releases/generate-notes`,
      '-f', `tag_name=${tag}`, '-f', 'configuration_file_path=.github/release.yml',
      ...(previousTag ? ['-f', `previous_tag_name=${previousTag}`] : [])));
    if (typeof notes.body !== 'string' || !notes.body.trim()) throw new Error('Generated release notes are empty');
    run('api', '-X', 'PATCH', `repos/${repo}/releases/${release.id}`,
      '-F', 'draft=false', '-f', 'make_latest=true', '-f', `body=${notes.body}`);
  }
  return String(release.id);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(readFileSync('packages/shell/package.json', 'utf8'));
  if (process.argv[2] === 'tag') {
    const tag = claimTag({ version, repo: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
    console.log(tag ? `Claimed ${tag}` : 'Version already has a tag; no release');
    process.exit(0);
  }
  const id = releaseTask(process.argv[2], {
    version, tag: process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME, repo: process.env.GITHUB_REPOSITORY,
    id: process.env.RELEASE_ID,
    previousTag: process.argv[2] === 'publish'
      ? execFileSync('git', ['tag', '--merged', 'HEAD', '--sort=-version:refname'], { encoding: 'utf8' })
        .split('\n').find(tag => /^v\d+\.\d+\.\d+$/.test(tag) && tag !== versionTag(version)) : undefined,
  });
  if (process.argv[2] === 'prepare' && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `release_id=${id}\n`);
  }
  console.log(`Release ${id}: ${process.argv[2]} succeeded`);
}
