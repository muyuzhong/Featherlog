import { describe, expect, it } from 'vitest';
import type { ChronicleEntry, Quest } from '@featherlog/contracts';
import { initialState, milestonesFor, reconcile, sheet } from './model';

const at = '2026-10-05T04:00:00.000Z';
function quest(patch: Partial<Quest> = {}): Quest {
  return { id: 'q', kind: 'side', title: 'Task', status: 'active', priority: 'none', tracked: false,
    revealed: false, chapters: [], order: 0, createdAt: at, updatedAt: at,
    derived: { chapterIndex: 0, objectiveIndex: 0, ratio: 0, chapterRatio: 0, streak: 0,
      dueToday: false, overdue: false }, ...patch };
}

describe('§16.2 reconciliation units', () => {
  it('credits ordinary objectives, counted high water, main chapters and completion only once', () => {
    const state = initialState();
    const entries: ChronicleEntry[] = [];
    const snapshot = quest({ kind: 'main', completedAt: at, chapters: [{ id: 'c', title: 'Book', doneAt: at,
      objectives: [{ id: 'o', text: 'Read', doneAt: at },
        { id: 'n', text: 'Count', count: { current: 5, target: 5 }, doneAt: at }] }] });
    reconcile(state, snapshot, entries);
    expect(sheet(state).unassigned).toBe(105);
    expect(entries.map(entry => entry.kind)).toEqual(['chapter-completed', 'quest-completed']);
    const undone = structuredClone(snapshot);
    delete undone.completedAt;
    delete undone.chapters[0]!.doneAt;
    for (const objective of undone.chapters[0]!.objectives) delete objective.doneAt;
    undone.chapters[0]!.objectives[1]!.count!.current = 2;
    reconcile(state, undone, entries);
    reconcile(state, snapshot, entries);
    expect(sheet(state).unassigned).toBe(105);
    snapshot.chapters[0]!.objectives[1]!.count!.current = 100;
    reconcile(state, snapshot, entries);
    expect(sheet(state).unassigned).toBe(150);
    expect(entries).toHaveLength(2);
  });

  it('credits a side quest without objectives and preserves its original chronicle label/time', () => {
    const state = initialState();
    const entries: ChronicleEntry[] = [];
    reconcile(state, quest({ completedAt: at, name: 'One deed' }), entries);
    reconcile(state, quest({ completedAt: '2026-11-01T04:00:00.000Z', title: 'Renamed' }), entries);
    expect(sheet(state).unassigned).toBe(20);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ at, label: 'One deed' });
  });

  it('recovers daily and weekly streak periods without crediting the current incomplete period', () => {
    for (const recurrence of [{ freq: 'daily' } as const, { freq: 'weekly', weekdays: [1, 3, 5] } as const]) {
      const state = initialState();
      const daily = quest({ kind: 'daily', recurrence: structuredClone(recurrence) as Quest['recurrence'],
        cycle: { periodKey: '2026-10-05', current: 0, done: false } });
      daily.derived.streak = 7;
      const entries: ChronicleEntry[] = [];
      reconcile(state, daily, entries);
      expect(state.accounts[0]!.periods).not.toContain('2026-10-05');
      expect(sheet(state).unassigned).toBe(35);
      daily.cycle!.done = true; daily.derived.streak = 8;
      reconcile(state, daily, entries);
      reconcile(state, daily, entries);
      expect(sheet(state).unassigned).toBe(40);
      expect(entries).toEqual([]);
    }
  });
});

describe('§16.2–16.4 distribution, ranks and titles', () => {
  it('distributes odd totals in attribute order and moves all points on reassignment', () => {
    const state = initialState();
    const account = reconcile(state, quest({ chapters: [{ id: 'c', title: '',
      objectives: [{ id: 'o', text: 'Count', count: { current: 1, target: 5 } }] }] }), []);
    expect(sheet(state).unassigned).toBe(3);
    account.attributes = ['learning'];
    expect(sheet(state).attributes.map(a => a.points)).toEqual([3, 0, 0, 0]);
    account.attributes = ['mind', 'body'];
    expect(sheet(state).attributes.map(a => a.points)).toEqual([0, 1, 2, 0]);
    account.attributes = ['body', 'mind'];
    expect(sheet(state).attributes.map(a => a.points)).toEqual([0, 2, 1, 0]);
    expect(sheet(state).unassigned).toBe(0);
  });

  it.each([[0, 0], [1, 1], [99, 1], [100, 2], [299, 2], [300, 3], [699, 3],
    [700, 4], [1499, 4], [1500, 5], [2999, 5], [3000, 6], [9999, 6]])(
    'uses threshold %i for rank %i', (points, rank) => {
      const state = initialState();
      const account = reconcile(state, quest({ attributes: ['learning'] }), []);
      account.points = points;
      const entries: ChronicleEntry[] = [];
      milestonesFor(state, at, entries);
      expect(sheet(state).attributes[0]).toMatchObject({ points, rank });
      expect(sheet(state).attributes[0]!.nextAt).toBe(rank === 6 ? undefined : [1, 100, 300, 700, 1500, 3000][rank]);
      expect(milestonesFor(state, at, entries)).toEqual([]);
      account.attributes = [];
      milestonesFor(state, at, entries);
      expect(sheet(state).attributes[0]!.rank).toBe(rank);
    },
  );

  it('awards fixed titles at the seventh/thirtieth period, fifth on-time quest and third main', () => {
    const state = initialState();
    const entries: ChronicleEntry[] = [];
    const daily = reconcile(state, quest({ kind: 'daily' }), entries);
    const earned = (id: string) => Boolean(state.titles.find(title => title.id === id)!.earnedAt);
    daily.streak = 6; milestonesFor(state, at, entries); expect(earned('seven-days')).toBe(false);
    daily.streak = 7; milestonesFor(state, at, entries); expect(earned('seven-days')).toBe(true);
    daily.streak = 29; milestonesFor(state, at, entries); expect(earned('thirty-days')).toBe(false);
    daily.streak = 30; milestonesFor(state, at, entries); expect(earned('thirty-days')).toBe(true);
    for (let i = 0; i < 5; i++) {
      reconcile(state, quest({ id: String(i), kind: i < 3 ? 'main' : 'side',
        completedAt: at, deadline: '2026-10-05' }), entries, '2026-10-05');
      milestonesFor(state, at, entries);
      expect(earned('on-time')).toBe(i === 4);
      expect(earned('three-volumes')).toBe(i >= 2);
    }
    expect(earned('first-volume')).toBe(true);
    expect(earned('one-deed')).toBe(true);
    expect(state.titles.filter(title => title.earnedAt).every(title => title.earnedAt === at)).toBe(true);
  });
});

it('awards both rank titles for all four attributes and preserves them after reassignment', () => {
  const state = initialState();
  const entries: ChronicleEntry[] = [];
  for (const attribute of ['learning', 'body', 'mind', 'craft'] as const) {
    const account = reconcile(state, quest({ id: attribute, attributes: [attribute] }), entries);
    account.points = 1500;
    milestonesFor(state, at, entries);
    for (const rank of [3, 5]) expect(state.titles.find(title => title.id === `${attribute}-${rank}`)!.earnedAt).toBe(at);
    account.attributes = [];
  }
  expect(milestonesFor(state, at, entries)).toEqual([]);
  expect(state.titles.filter(title => title.earnedAt)).toHaveLength(8);
});
