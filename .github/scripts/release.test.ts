import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { expectedAssets, releaseTask } from './release.mjs';

afterEach(() => vi.unstubAllEnvs());

const options = { version: '0.1.1', tag: 'v0.1.1', repo: 'owner/repo', id: '42' };
const draft = { id: 42, tag_name: 'v0.1.1', draft: true };
const names = [
  'Featherlog-0.1.1-x86_64.AppImage',
  'Featherlog-0.1.1-x64.exe', 'Featherlog-0.1.1-x64.exe.blockmap',
  'Featherlog-0.1.1-arm64.dmg', 'Featherlog-0.1.1-arm64.dmg.blockmap',
  'Featherlog-0.1.1-x64.dmg', 'Featherlog-0.1.1-x64.dmg.blockmap',
  'latest.yml', 'latest-linux.yml', 'latest-mac.yml',
];
const assets = names.map(name => ({ name, state: 'uploaded', size: 100 }));

it('rejects a mismatched tag before any API call', () => {
  const gh = vi.fn();
  expect(() => releaseTask('prepare', { ...options, tag: 'v0.1.0' }, gh)).toThrow('does not match');
  expect(gh).not.toHaveBeenCalled();
});

it('creates one draft and reuses it on rerun', () => {
  let created = false;
  const gh = vi.fn((...args: string[]) => {
    if (args[1] === '--paginate') return JSON.stringify([created ? [draft] : []]);
    expect(args).toEqual(['api', '-X', 'POST', 'repos/owner/repo/releases',
      '-f', 'tag_name=v0.1.1', '-f', 'name=v0.1.1', '-F', 'draft=true']);
    created = true;
    return JSON.stringify(draft);
  });
  expect(releaseTask('prepare', options, gh)).toBe('42');
  expect(releaseTask('prepare', options, gh)).toBe('42');
  expect(gh.mock.calls.filter(args => args.includes('POST'))).toHaveLength(1);
});

it('returns the creation response ID even while the release list remains stale', () => {
  const gh = vi.fn((...args: string[]) => args.includes('POST')
    ? JSON.stringify({ ...draft, id: 398129844 }) : '[[]]');
  expect(releaseTask('prepare', options, gh)).toBe('398129844');
  expect(gh.mock.calls.filter(args => args.includes('--paginate'))).toHaveLength(1);
  expect(gh).toHaveBeenCalledTimes(2);
});

it('propagates creation errors without another list query or creation attempt', () => {
  const gh = vi.fn().mockReturnValueOnce('[[]]').mockImplementationOnce(() => {
    throw new Error('HTTP 422');
  });
  expect(() => releaseTask('prepare', options, gh)).toThrow('HTTP 422');
  expect(gh).toHaveBeenCalledTimes(2);
});

it.each([
  [[draft, { ...draft, id: 43 }], 'Multiple releases'],
  [[{ ...draft, draft: false }], 'already published'],
] as const)('refuses ambiguous or published releases', (releases, error) => {
  const gh = vi.fn(() => JSON.stringify([releases]));
  expect(() => releaseTask('prepare', options, gh)).toThrow(error);
  expect(gh).toHaveBeenCalledTimes(1);
});

it('propagates API errors instead of treating them as a missing release', () => {
  const gh = vi.fn(() => { throw new Error('HTTP 403'); });
  expect(() => releaseTask('prepare', options, gh)).toThrow('HTTP 403');
  expect(gh).toHaveBeenCalledTimes(1);
});

it('checks draft identity and publisher visibility before upload', () => {
  const gh = vi.fn().mockReturnValueOnce(JSON.stringify([[], [draft]]))
    .mockReturnValueOnce(JSON.stringify([draft]));
  expect(releaseTask('check', options, gh)).toBe('42');
  expect(() => releaseTask('check', options, () => '[[]]')).toThrow('does not exist');
  expect(() => releaseTask('check', { ...options, id: '99' }, () => JSON.stringify([[draft]])))
    .toThrow('Draft changed');
  gh.mockReturnValueOnce(JSON.stringify([[draft]])).mockReturnValueOnce('[]');
  expect(() => releaseTask('check', options, gh)).toThrow('first page');
});

function verify(items = assets) {
  const gh = vi.fn().mockReturnValueOnce(JSON.stringify([[draft]]))
    .mockReturnValueOnce(JSON.stringify([items.slice(0, 7), items.slice(7)]));
  return releaseTask('verify', options, gh);
}

it('accepts exactly the 10 expected, fully uploaded assets across API pages', () => {
  expect(expectedAssets('0.1.1')).toEqual([...names].sort());
  expect(verify()).toBe('42');
});

it('the installed builder generates mac update metadata from both DMGs without ZIPs', async () => {
  const shell = createRequire(new URL('../../packages/shell/package.json', import.meta.url));
  const builder = createRequire(shell.resolve('electron-builder'));
  const appBuilder = createRequire(builder.resolve('app-builder-lib'));
  const { createUpdateInfoTasks, writeUpdateInfoFiles } = appBuilder('./publish/updateInfoBuilder');
  const { Platform } = appBuilder('./core');
  const { Arch } = appBuilder('builder-util');
  const directory = await mkdtemp(join(tmpdir(), 'featherlog-mac-metadata-'));
  const packager = {
    platform: Platform.MAC, appInfo: { version: options.version },
    platformSpecificBuildOptions: {}, config: {}, info: {},
    getResource: async () => null,
  };
  const publish = { provider: 'github', owner: 'owner', repo: 'repo' };
  try {
    const tasks = (await Promise.all(['arm64', 'x64'].map(arch => createUpdateInfoTasks({
      packager, target: { outDir: directory }, arch: Arch[arch],
      file: join(directory, `Featherlog-${options.version}-${arch}.dmg`),
      updateInfo: { sha512: 'test-checksum', size: 100 },
    }, [publish])))).flat();
    const emitArtifactCreated = vi.fn();
    await writeUpdateInfoFiles(tasks, { emitArtifactCreated });
    const metadata = await readFile(join(directory, 'latest-mac.yml'), 'utf8');
    expect(metadata).toContain('Featherlog-0.1.1-arm64.dmg');
    expect(metadata).toContain('Featherlog-0.1.1-x64.dmg');
    expect(metadata).not.toContain('.zip');
    expect(emitArtifactCreated).toHaveBeenCalledOnce();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(names)('rejects a missing %s', name => {
  expect(() => verify(assets.filter(asset => asset.name !== name))).toThrow(name);
});

it('rejects extra, duplicate, empty and unfinished assets', () => {
  expect(() => verify([...assets, { ...assets[0]!, name: 'unexpected.zip' }])).toThrow('extra');
  expect(() => verify([...assets, assets[0]!])).toThrow('duplicate');
  expect(() => verify(assets.map(asset => ({ ...asset, size: 0 })))).toThrow('incomplete');
  expect(() => verify(assets.map(asset => ({ ...asset, state: 'starter' })))).toThrow('incomplete');
});

it('the installed publisher reuses a draft and cannot create one without a CI tag', async () => {
  const shell = createRequire(new URL('../../packages/shell/package.json', import.meta.url));
  const builder = createRequire(shell.resolve('electron-builder'));
  const appBuilder = createRequire(builder.resolve('app-builder-lib'));
  const { GitHubPublisher } = appBuilder('electron-publish/out/gitHubPublisher');
  for (const name of ['GITHUB_REF_TYPE', 'GITHUB_REF_NAME', 'TRAVIS_TAG',
    'APPVEYOR_REPO_TAG_NAME', 'CIRCLE_TAG', 'BITRISE_GIT_TAG', 'CI_BUILD_TAG',
    'CI_COMMIT_TAG', 'BITBUCKET_TAG']) vi.stubEnv(name, '');
  const publisher = {
    info: { owner: 'owner', repo: 'repo' }, tag: options.tag, version: options.version,
    releaseType: 'draft', options: { publish: 'onTagOrDraft' },
    githubRequest: vi.fn().mockResolvedValueOnce([draft]).mockResolvedValueOnce([]),
    createRelease: vi.fn(),
  };
  expect(await GitHubPublisher.prototype.getOrCreateRelease.call(publisher)).toEqual(draft);
  expect(await GitHubPublisher.prototype.getOrCreateRelease.call(publisher)).toBeNull();
  expect(publisher.createRelease).not.toHaveBeenCalled();
});
