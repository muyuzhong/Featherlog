import type { Language, WorkSlot } from '../rpc/types';
import { messages } from './i18n';

const DAY_MS = 86_400_000;

const pad = (n: number): string => String(n).padStart(2, '0');

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The day a moment belongs to: before dayStartHour it still counts as yesterday. */
export function periodKeyOf(now: number, dayStartHour: number): string {
  const d = new Date(now);
  // Comparing local hours, not subtracting milliseconds, keeps DST days right.
  if (d.getHours() < dayStartHour) d.setDate(d.getDate() - 1);
  return dateKey(d);
}

export function parseDateKey(key: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return new Date(Number.NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function addDays(key: string, days: number): string {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDateKey(b).getTime() - parseDateKey(a).getTime()) / DAY_MS);
}

export function weekdayOf(key: string): number {
  return parseDateKey(key).getDay();
}

/** When a period begins, in Unix ms. */
export function periodStart(key: string, dayStartHour: number): number {
  const d = parseDateKey(key);
  d.setHours(dayStartHour, 0, 0, 0);
  return d.getTime();
}

/** 42s, 14m, 1h05, 3d: short enough for a tray chip, stable with tabular figures. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${pad(m % 60)}`;
  return `${Math.floor(h / 24)}d`;
}

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatStamp(ms: number, now: number): string {
  const d = new Date(ms);
  const n = new Date(now);
  if (dateKey(d) === dateKey(n)) return formatClock(ms);
  if (d.getFullYear() === n.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatClock(ms)}`;
  return dateKey(d);
}

export function formatDeadline(deadline: string, today: string, language: Language = 'zh'): string {
  return messages(language).tasks.deadline(daysBetween(today, deadline), deadline);
}

// ---- Reminder hairline ----

export interface ReminderStart {
  remindAt: number;
  /** when the countdown the hairline measures began */
  start: number;
}

export type ReminderStarts = Record<string, ReminderStart>;

/**
 * Remembers when each running slot's reminder was set. The contract carries
 * only remindAt, so a reminder first seen at load counts from the slot's
 * state change, and one that appears or moves later counts from that moment.
 */
export function trackReminders(
  prev: ReminderStarts,
  slots: readonly WorkSlot[],
  now: number,
  initial: boolean,
): ReminderStarts {
  const next: ReminderStarts = {};
  for (const slot of slots) {
    if (slot.state !== 'running' || slot.remindAt == null) continue;
    const known = prev[slot.id];
    if (known && known.remindAt === slot.remindAt) {
      next[slot.id] = known;
      continue;
    }
    const from = initial ? slot.stateChangedAt : now;
    next[slot.id] = { remindAt: slot.remindAt, start: Math.min(from, slot.remindAt) };
  }
  return next;
}

/** How much of the countdown has passed, 0 to 1. */
export function reminderProgress(r: ReminderStart, now: number): number {
  const total = r.remindAt - r.start;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (now - r.start) / total));
}
