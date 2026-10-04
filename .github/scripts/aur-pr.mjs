import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { versionTag } from './release.mjs';

const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8' });

export function proposeAur(version, repo, run = execute) {
  const tag = versionTag(version);
  const branch = `ci/aur-${tag}`;
  const files = ['packaging/aur/featherlog-bin/PKGBUILD', 'packaging/aur/featherlog-bin/.SRCINFO'];
  const changes = run('git', ['diff', '--name-only']).trim().split('\n').filter(Boolean);
  if (changes.some(file => !files.includes(file))) throw new Error('Unexpected changes outside the AUR recipe');
  if (!changes.length) return '';
  run('git', ['switch', '-c', branch]);
  run('git', ['config', 'user.name', 'github-actions[bot]']);
  run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  run('git', ['add', '--', ...files]);
  run('git', ['commit', '-m', `chore(aur): update featherlog-bin to ${tag}`]);
  run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  const directory = mkdtempSync(join(tmpdir(), 'featherlog-aur-pr-'));
  try {
    const body = join(directory, 'body.md');
    writeFileSync(body, `## 做了什么\n\n将 AUR 的 PKGBUILD 与 .SRCINFO 更新到 [${tag}](https://github.com/${repo}/releases/tag/${tag})，重置 pkgrel 并更新 AppImage 和 LICENSE 的 SHA-256。\n\n## 契约变更\n\n无。\n\n## 测试覆盖了哪些规则\n\n在 Arch 容器中运行 packaging/aur/update.test.sh，执行 update.sh 下载正式发布的文件并由 makepkg --printsrcinfo 生成元数据。\n\n## 与设计文档不一致或设计文档没写清楚的地方\n\n无。仅提出 PR，等待审查，不直接推 main。\n`);
    return run('gh', ['pr', 'create', '--repo', repo, '--base', 'main', '--head', branch,
      '--title', `chore(aur): update featherlog-bin to ${tag}`, '--body-file', body]).trim();
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.env.RELEASE_TAG ?? '';
  console.log(proposeAur(tag.replace(/^v/, ''), process.env.GITHUB_REPOSITORY));
}
