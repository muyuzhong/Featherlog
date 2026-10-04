import { existsSync, readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { proposeAur } from './aur-pr.mjs';

const files = ['packaging/aur/featherlog-bin/PKGBUILD', 'packaging/aur/featherlog-bin/.SRCINFO'];

it('stages only the two recipe files and opens a reviewed PR using a real multiline body file', () => {
  let bodyFile = '';
  const run = vi.fn((command: string, args: string[]) => {
    if (args[0] === 'diff') return files.join('\n');
    if (command === 'gh') {
      bodyFile = args.at(-1)!;
      const body = readFileSync(bodyFile, 'utf8');
      for (const heading of ['做了什么', '契约变更', '测试覆盖了哪些规则', '与设计文档不一致或设计文档没写清楚的地方']) {
        expect(body).toContain(`## ${heading}\n\n`);
      }
      expect(body).toContain('https://github.com/owner/repo/releases/tag/v1.2.3');
      expect(body).not.toContain('\\n');
      return 'https://github.com/owner/repo/pull/7\n';
    }
    return '';
  });
  expect(proposeAur('1.2.3', 'owner/repo', run)).toBe('https://github.com/owner/repo/pull/7');
  expect(run).toHaveBeenCalledWith('git', ['switch', '-c', 'ci/aur-v1.2.3']);
  expect(run).toHaveBeenCalledWith('git', ['add', '--', ...files]);
  expect(run).toHaveBeenCalledWith('git', ['push', 'origin', 'HEAD:refs/heads/ci/aur-v1.2.3']);
  expect(run).toHaveBeenCalledWith('gh', ['pr', 'create', '--repo', 'owner/repo', '--base', 'main',
    '--head', 'ci/aur-v1.2.3', '--title', 'chore(aur): update featherlog-bin to v1.2.3', '--body-file', bodyFile]);
  expect(existsSync(bodyFile)).toBe(false);
});

it('skips unchanged recipes and refuses unrelated changes without committing or pushing', () => {
  const unchanged = vi.fn(() => '');
  expect(proposeAur('1.2.3', 'owner/repo', unchanged)).toBe(''); expect(unchanged).toHaveBeenCalledOnce();
  const unrelated = vi.fn(() => `${files[0]}\npackages/shell/package.json`);
  expect(() => proposeAur('1.2.3', 'owner/repo', unrelated)).toThrow('Unexpected changes');
  expect(unrelated).toHaveBeenCalledOnce();
});

it.each(['commit', 'push', 'create'])('fails on %s and never continues towards a later step', action => {
  let bodyFile = '';
  const run = vi.fn((command: string, args: string[]) => {
    if (args[0] === 'diff') return files.join('\n');
    if (args.includes(action)) {
      if (command === 'gh') bodyFile = args.at(-1)!;
      throw new Error('permission denied');
    }
    return '';
  });
  expect(() => proposeAur('1.2.3', 'owner/repo', run)).toThrow('permission denied');
  expect(run.mock.calls.at(-1)![1]).toContain(action);
  if (bodyFile) expect(existsSync(bodyFile)).toBe(false);
});
