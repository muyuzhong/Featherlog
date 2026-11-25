import { describe, expect, it } from 'vitest';
import type { Task } from '../rpc/types';
import {
  computeDue,
  parseQuickTask,
  rollDaily,
  setCompleted,
  stepQuota,
  todoTally,
  todoView,
  toggleItem,
} from './tasks';

const today = '2026-11-25'; // a Wednesday
const base = (patch: Partial<Task>): Task => ({
  id: 't',
  kind: 'side',
  title: 't',
  status: 'active',
  items: [],
  dueToday: false,
  overdue: false,
  order: 0,
  createdAt: 0,
  ...patch,
});

describe('items: free order, no sequence lock', () => {
  const task = base({
    items: [
      { id: 'a', text: 'a', done: false },
      { id: 'b', text: 'b', done: false },
      { id: 'c', text: 'c', done: false },
    ],
  });

  it('checks the last item before the first', () => {
    const next = toggleItem(task, 'c', undefined);
    expect(next.items.map((i) => i.done)).toEqual([false, false, true]);
    expect(toggleItem(next, 'a', true).items.map((i) => i.done)).toEqual([true, false, true]);
  });

  it('unchecks again, and leaves the task itself alone', () => {
    const done = toggleItem(toggleItem(toggleItem(task, 'a', true), 'b', true), 'c', true);
    expect(done.status).toBe('active');
    expect(toggleItem(done, 'b', undefined).items[1]?.done).toBe(false);
  });

  it('fills an item count when checked', () => {
    const counted = base({ items: [{ id: 'a', text: 'a', done: false, current: 1, target: 5 }] });
    expect(toggleItem(counted, 'a', true).items[0]).toMatchObject({ done: true, current: 5 });
    expect(toggleItem(toggleItem(counted, 'a', true), 'a', false).items[0]).toMatchObject({ done: false, current: 4 });
  });

  it('rejects an unknown item', () => {
    expect(() => toggleItem(task, 'zz', true)).toThrow('task/item-not-found');
  });
});

describe('stepQuota', () => {
  const quota = base({ quota: { current: 4, target: 5 } });

  it('completes the task when the count reaches its target', () => {
    const next = stepQuota(quota, 1, undefined, 99);
    expect(next.quota).toEqual({ current: 5, target: 5 });
    expect(next.status).toBe('completed');
    expect(next.completedAt).toBe(99);
  });

  it('reopens it when the count drops back, and never leaves 0..target', () => {
    const full = stepQuota(quota, 1, undefined, 99);
    const back = stepQuota(full, -1, undefined, 100);
    expect(back.status).toBe('active');
    expect(back).not.toHaveProperty('completedAt');
    expect(stepQuota(full, 1, undefined, 0).quota?.current).toBe(5);
    expect(stepQuota(base({ quota: { current: 0, target: 3 } }), -1, undefined, 0).quota?.current).toBe(0);
  });

  it('steps an item count and marks the item done at its target', () => {
    const task = base({ items: [{ id: 'a', text: 'a', done: false, current: 2, target: 3 }] });
    expect(stepQuota(task, 1, 'a', 0).items[0]).toMatchObject({ current: 3, done: true });
    expect(stepQuota(task, -1, 'a', 0).items[0]).toMatchObject({ current: 1, done: false });
  });

  it('keeps a daily streak in step with completing and reopening', () => {
    const daily = base({ kind: 'daily', quota: { current: 0, target: 1 }, streak: 3 });
    const done = stepQuota(daily, 1, undefined, 1);
    expect(done.streak).toBe(4);
    expect(stepQuota(done, -1, undefined, 2).streak).toBe(3);
  });
});

describe('daily periods', () => {
  const daily = base({
    kind: 'daily',
    recurrence: { freq: 'daily' },
    periodKey: '2026-11-24',
    status: 'completed',
    completedAt: 1,
    streak: 2,
    dueToday: true,
    quota: { current: 8, target: 8 },
    items: [{ id: 'a', text: 'a', done: true, current: 3, target: 3 }],
  });

  it('resets count, items and completion on a new period and keeps a kept streak', () => {
    const next = rollDaily(daily, today, 4);
    expect(next).toMatchObject({ status: 'active', periodKey: today, streak: 2, quota: { current: 0, target: 8 } });
    expect(next.items[0]).toMatchObject({ done: false, current: 0 });
    expect(next).not.toHaveProperty('completedAt');
  });

  it('breaks the streak when a due period was missed', () => {
    expect(rollDaily({ ...daily, status: 'active' }, today, 4).streak).toBe(0);
  });

  it('keeps the streak over a day the task was not due', () => {
    expect(rollDaily({ ...daily, status: 'active', dueToday: false }, today, 4).streak).toBe(2);
  });

  it('does nothing within the same period', () => {
    const same = { ...daily, periodKey: today };
    expect(rollDaily(same, today, 4)).toBe(same);
  });

  it('is due on the weekdays of a weekly recurrence only', () => {
    const weekly = base({ kind: 'daily', recurrence: { freq: 'weekly', weekdays: [1, 3, 5] } });
    expect(computeDue(weekly, today, 4).dueToday).toBe(true);
    expect(computeDue(weekly, '2026-11-26', 4).dueToday).toBe(false);
  });
});

describe('due, overdue and tabs', () => {
  it('marks scheduled and deadline work due, and past deadlines overdue', () => {
    expect(computeDue(base({ scheduledFor: today }), today, 4)).toEqual({ dueToday: true, overdue: false });
    expect(computeDue(base({ deadline: '2026-11-24' }), today, 4)).toEqual({ dueToday: true, overdue: true });
    expect(computeDue(base({ deadline: '2026-11-28' }), today, 4)).toEqual({ dueToday: false, overdue: false });
    expect(computeDue(base({}), today, 4).dueToday).toBe(false);
  });

  it('keeps finished main and side work on today only on the day it was finished', () => {
    const doneToday = base({ status: 'completed', completedAt: new Date(2026, 10, 25, 9).getTime(), scheduledFor: '2026-11-20' });
    const doneBefore = { ...doneToday, completedAt: new Date(2026, 10, 25, 3).getTime() };
    expect(computeDue(doneToday, today, 4).dueToday).toBe(true);
    expect(computeDue(doneBefore, today, 4).dueToday).toBe(false);
  });

  it('lists every todo flat: open in the order added, then today\'s finished ones', () => {
    const tasks = [
      base({ id: 'late', createdAt: 30 }),
      base({ id: 'main', kind: 'main', createdAt: 10, overdue: true }),
      base({ id: 'daily-due', kind: 'daily', createdAt: 20, dueToday: true }),
      base({ id: 'daily-off', kind: 'daily', createdAt: 5, dueToday: false }),
      base({ id: 'done-a', status: 'completed', dueToday: true, completedAt: 100 }),
      base({ id: 'done-b', status: 'completed', dueToday: true, completedAt: 200 }),
      base({ id: 'done-old', status: 'completed', dueToday: false, completedAt: 1 }),
      base({ id: 'gone', status: 'archived' }),
    ];
    const { open, done } = todoView(tasks);
    expect(open.map((t) => t.id)).toEqual(['main', 'daily-due', 'late']);
    expect(done.map((t) => t.id)).toEqual(['done-b', 'done-a']);
    expect(todoTally(tasks)).toEqual({ done: 2, total: 5 });
  });

  it('completes and reopens', () => {
    const done = setCompleted(base({}), true, 7);
    expect(done).toMatchObject({ status: 'completed', completedAt: 7 });
    expect(setCompleted(done, false, 8)).not.toHaveProperty('completedAt');
  });
});

describe('parseQuickTask', () => {
  it('reads a trailing count as the target', () => {
    expect(parseQuickTask('喝水 ×8')).toEqual({ title: '喝水', target: 8 });
    expect(parseQuickTask('俯卧撑 x20 ')).toEqual({ title: '俯卧撑', target: 20 });
    expect(parseQuickTask('读书*3')).toEqual({ title: '读书', target: 3 });
  });

  it('leaves ordinary titles alone', () => {
    expect(parseQuickTask(' 写周报 ')).toEqual({ title: '写周报' });
    expect(parseQuickTask('×5')).toEqual({ title: '×5' });
    expect(parseQuickTask('第 3 版 x0')).toEqual({ title: '第 3 版 x0' });
  });
});
