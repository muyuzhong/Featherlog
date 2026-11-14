import type { Quest, UiBus } from '@featherlog/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Objectives } from './Objectives';
import { createQuestStore } from './store';

const quest: Quest = {
  id: 'q1', kind: 'side', title: 'Task', status: 'active', priority: 'none',
  tracked: true, revealed: false, order: 0,
  createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
  chapters: [{ id: 'c1', title: '', objectives: [
    { id: 'o1', text: 'First done', doneAt: '2026-10-25T00:00:00.000Z' },
    { id: 'o2', text: 'Second done', doneAt: '2026-10-25T00:00:00.000Z' },
    { id: 'o3', text: 'Current step' },
    { id: 'o4', text: 'Future step' },
    { id: 'o5', text: 'Last step' },
  ] }],
  derived: { chapterIndex: 0, objectiveIndex: 2, ratio: 0.4, chapterRatio: 0.4,
    streak: 0, dueToday: false, overdue: false },
};

function render(overrides: Partial<Quest>, compact: boolean) {
  const bus: UiBus = {
    on: () => () => {},
    emit: () => {},
    request: () => new Promise(() => {}),
  };
  const store = createQuestStore(bus);
  try {
    return renderToStaticMarkup(createElement(Objectives, { quest: { ...quest, ...overrides }, store, compact }));
  } finally {
    store.dispose();
  }
}

it.each([false, true])('shows all side objectives with compact=%s, regardless of revealed', (compact) => {
  for (const revealed of [false, true]) {
    const html = render({ revealed }, compact);
    for (const objective of quest.chapters[0]!.objectives) expect(html).toContain(objective.text);
    expect(html).not.toContain('未曾揭晓');
    expect(html).not.toContain('此前已完成');
    const buttons = html.match(/<button\b[^]*?<\/button>/g)?.join('');
    expect(buttons).not.toContain('Future step');
    expect(buttons).not.toContain('Last step');
  }
});

it.each([
  { revealed: false, compact: false, visible: false },
  { revealed: true, compact: false, visible: true },
  { revealed: true, compact: true, visible: false },
])('preserves main objective visibility: %j', ({ revealed, compact, visible }) => {
  const html = render({ kind: 'main', revealed }, compact);
  expect(html.includes('Future step')).toBe(visible);
  expect(html.includes('未曾揭晓')).toBe(!visible);
  expect(html.includes('First done')).toBe(!compact);
  expect(html).toContain('Second done');
  expect(html).toContain('Current step');
});
