import type { Task } from '../rpc/types';
import { omitUndefined } from './json';
import { daysBetween, periodStart, weekdayOf } from './time';

/** dueToday and overdue as of a period (a YYYY-MM-DD key). */
export function computeDue(task: Task, periodKey: string, dayStartHour: number): { dueToday: boolean; overdue: boolean } {
  if (task.status === 'archived') return { dueToday: false, overdue: false };
  const overdue = task.status === 'active' && task.deadline != null && daysBetween(periodKey, task.deadline) < 0;
  if (task.kind === 'daily') {
    const r = task.recurrence;
    const due = !r || r.freq === 'daily' || (r.weekdays ?? []).includes(weekdayOf(periodKey));
    return { dueToday: due, overdue };
  }
  if (task.status === 'completed') {
    // Finished work stays on today's list only on the day it was finished.
    const done = task.completedAt != null && task.completedAt >= periodStart(periodKey, dayStartHour);
    return { dueToday: done, overdue: false };
  }
  const anchor = task.scheduledFor ?? task.deadline;
  return { dueToday: anchor != null && daysBetween(periodKey, anchor) <= 0, overdue };
}

export function withDue(task: Task, periodKey: string, dayStartHour: number): Task {
  return { ...task, ...computeDue(task, periodKey, dayStartHour) };
}

/**
 * Starts a daily task's new period: its count, items and completion reset.
 * The streak carries on only if the period it leaves was completed, or was
 * not one it was due in.
 */
export function rollDaily(task: Task, periodKey: string, dayStartHour: number): Task {
  if (task.kind !== 'daily' || task.periodKey === periodKey || task.status === 'archived') return task;
  const finished = task.status === 'completed';
  const keepStreak = finished || !task.dueToday;
  return withDue(
    omitUndefined({
      ...task,
      status: 'active' as const,
      completedAt: undefined,
      periodKey,
      streak: keepStreak ? (task.streak ?? 0) : 0,
      quota: task.quota ? { ...task.quota, current: 0 } : undefined,
      items: task.items.map((item) => omitUndefined({ ...item, done: false, current: item.target != null ? 0 : item.current })),
    }),
    periodKey,
    dayStartHour,
  );
}

export function setCompleted(task: Task, completed: boolean, now: number): Task {
  const was = task.status === 'completed';
  if (was === completed) return task;
  let streak = task.streak;
  if (task.kind === 'daily') streak = Math.max(0, (task.streak ?? 0) + (completed ? 1 : -1));
  return omitUndefined({
    ...task,
    status: completed ? ('completed' as const) : ('active' as const),
    completedAt: completed ? now : undefined,
    streak,
  });
}

/** Items check off in any order: there is no sequence lock. */
export function toggleItem(task: Task, itemId: string, done: boolean | undefined): Task {
  const item = task.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`task/item-not-found: ${itemId}`);
  const next = done ?? !item.done;
  return {
    ...task,
    items: task.items.map((i) => {
      if (i.id !== itemId) return i;
      if (i.target == null) return { ...i, done: next };
      const current = next ? i.target : Math.min(i.current ?? 0, i.target - 1);
      return { ...i, done: next, current: Math.max(0, current) };
    }),
  };
}

/** +1/-1 on a task's or an item's count; reaching the target completes it. */
export function stepQuota(task: Task, delta: number, itemId: string | undefined, now: number): Task {
  const step = Math.sign(delta);
  if (itemId) {
    return {
      ...task,
      items: task.items.map((i) => {
        if (i.id !== itemId || i.target == null) return i;
        const current = clamp((i.current ?? 0) + step, 0, i.target);
        return { ...i, current, done: current >= i.target };
      }),
    };
  }
  if (!task.quota) throw new Error(`task/no-quota: ${task.id}`);
  const current = clamp(task.quota.current + step, 0, task.quota.target);
  const stepped = { ...task, quota: { ...task.quota, current } };
  if (current >= task.quota.target) return setCompleted(stepped, true, now);
  if (task.status === 'completed') return setCompleted(stepped, false, now);
  return stepped;
}

/**
 * The panel's one list. Every task is an equal todo: open ones in the order
 * they were added, then what was finished this period, latest first. A daily
 * task shows only on the days it is due; older finished work leaves the list.
 */
export function todoView(tasks: readonly Task[]): { open: Task[]; done: Task[] } {
  const live = tasks.filter((t) => t.status !== 'archived');
  const open = live
    .filter((t) => t.status === 'active' && (t.kind !== 'daily' || t.dueToday))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const done = live
    .filter((t) => t.status === 'completed' && t.dueToday)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0) || a.createdAt - b.createdAt);
  return { open, done };
}

/** "3/5" beside 待办: finished this period out of everything the list shows. */
export function todoTally(tasks: readonly Task[]): { done: number; total: number } {
  const { open, done } = todoView(tasks);
  return { done: done.length, total: open.length + done.length };
}

export function itemProgress(task: Task): { done: number; total: number } {
  return { done: task.items.filter((i) => i.done).length, total: task.items.length };
}

/** "喝水 ×8" (or x8, *8): the trailing count becomes the target. */
export function parseQuickTask(text: string): { title: string; target?: number } {
  const m = /^(.*?)\s*[×xX*]\s*(\d{1,3})\s*$/.exec(text.trim());
  if (m && m[1] && Number(m[2]) > 0) return { title: m[1].trim(), target: Number(m[2]) };
  return { title: text.trim() };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
