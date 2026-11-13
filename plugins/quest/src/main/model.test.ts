import { expect, it } from 'vitest';
import type { Chapter } from '@featherlog/contracts';
import { chapters, patch } from './model';
import type { StoredQuest } from './model';

it('retains progress by id when a large chapter list is reordered without mutating old data', () => {
  const old: Chapter[] = Array.from({ length: 50 }, (_, i) => ({
    id: `chapter-${i}`, title: `Chapter ${i}`, objectives: Array.from({ length: 100 }, (_, j) => ({
      id: `objective-${i}-${j}`, text: `Objective ${j}`, count: { target: 5, current: j % 5 },
    })),
  }));
  const original = structuredClone(old);
  const drafts = [...old].reverse().map(chapter => ({ ...chapter, objectives: [...chapter.objectives].reverse() }));
  const result = chapters('main', drafts, old);
  expect(result).toEqual(drafts);
  result[0]!.objectives[0]!.count!.current = 99;
  expect(old).toEqual(original);
});

it('validates patches before mutating fields and keeps untouched chapter data', () => {
  const quest: StoredQuest = {
    id: 'q', kind: 'main', title: 'Before', status: 'active', priority: 'none', tracked: false,
    revealed: false, order: 0, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    chapters: [{ id: 'c', title: 'Chapter', objectives: [{ id: 'o', text: 'Read', count: { target: 5, current: 2 } }] }],
  };
  const original = structuredClone(quest);
  const savedChapters = quest.chapters;
  expect(() => patch(quest, { title: 'After', deadline: 'invalid' })).toThrow();
  expect(quest).toEqual(original);
  expect(patch(quest, { title: ' After ' })).toEqual(['title']);
  expect(quest).toEqual({ ...original, title: 'After' });
  expect(quest.chapters).toBe(savedChapters);
});
