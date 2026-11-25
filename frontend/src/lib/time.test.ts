import { describe, expect, it } from 'vitest';
import type { WorkSlot } from '../rpc/types';
import {
  addDays,
  daysBetween,
  formatDeadline,
  formatElapsed,
  formatStamp,
  periodKeyOf,
  periodStart,
  reminderProgress,
  trackReminders,
  weekdayOf,
} from './time';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe('periodKeyOf', () => {
  it('counts the hours before dayStartHour as the day before', () => {
    expect(periodKeyOf(at(2026, 11, 25, 3, 59), 4)).toBe('2026-11-24');
    expect(periodKeyOf(at(2026, 11, 25, 4, 0), 4)).toBe('2026-11-25');
  });

  it('rolls back across a month and a year', () => {
    expect(periodKeyOf(at(2026, 12, 1, 2), 4)).toBe('2026-11-30');
    expect(periodKeyOf(at(2027, 1, 1, 0, 30), 4)).toBe('2026-12-31');
  });

  it('with dayStartHour 0 is the calendar day', () => {
    expect(periodKeyOf(at(2026, 11, 25, 0, 0), 0)).toBe('2026-11-25');
  });
});

describe('date keys', () => {
  it('adds days and measures gaps across months', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-11-25', '2026-12-02')).toBe(7);
    expect(daysBetween('2026-11-25', '2026-11-24')).toBe(-1);
  });

  it('knows the weekday', () => {
    expect(weekdayOf('2026-11-25')).toBe(3);
  });

  it('starts a period at dayStartHour', () => {
    expect(periodStart('2026-11-25', 4)).toBe(at(2026, 11, 25, 4));
  });
});

describe('formatElapsed', () => {
  it('steps from seconds to minutes, hours and days', () => {
    expect(formatElapsed(-5)).toBe('0s');
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(14 * 60_000 + 59_000)).toBe('14m');
    expect(formatElapsed(65 * 60_000)).toBe('1h05');
    expect(formatElapsed(50 * 3_600_000)).toBe('2d');
  });
});

describe('formatDeadline and formatStamp', () => {
  it('names overdue, today, tomorrow and later deadlines', () => {
    expect(formatDeadline('2026-11-23', '2026-11-25')).toBe('逾期 2 天');
    expect(formatDeadline('2026-11-25', '2026-11-25')).toBe('今天截止');
    expect(formatDeadline('2026-11-26', '2026-11-25')).toBe('明天截止');
    expect(formatDeadline('2026-11-28', '2026-11-25')).toBe('11-28 截止');
  });

  it('names them in English too', () => {
    expect(formatDeadline('2026-11-24', '2026-11-25', 'en')).toBe('1 day overdue');
    expect(formatDeadline('2026-11-23', '2026-11-25', 'en')).toBe('2 days overdue');
    expect(formatDeadline('2026-11-25', '2026-11-25', 'en')).toBe('Due today');
    expect(formatDeadline('2026-11-26', '2026-11-25', 'en')).toBe('Due tomorrow');
    expect(formatDeadline('2026-11-28', '2026-11-25', 'en')).toBe('Due 11-28');
  });

  it('drops the date on the same day', () => {
    const now = at(2026, 11, 25, 15);
    expect(formatStamp(at(2026, 11, 25, 9, 5), now)).toBe('09:05');
    expect(formatStamp(at(2026, 11, 24, 23, 0), now)).toBe('11-24 23:00');
    expect(formatStamp(at(2025, 1, 2), now)).toBe('2025-01-02');
  });
});

describe('reminder hairline', () => {
  const slot = (patch: Partial<WorkSlot>): WorkSlot => ({
    id: 's',
    title: 't',
    state: 'running',
    breadcrumb: '',
    stateChangedAt: 1000,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  });

  it('counts a reminder found at load from the state change', () => {
    const r = trackReminders({}, [slot({ remindAt: 11_000 })], 5000, true);
    expect(r.s).toEqual({ remindAt: 11_000, start: 1000 });
    expect(reminderProgress(r.s!, 6000)).toBeCloseTo(0.5);
  });

  it('counts a reminder set later from when it was seen', () => {
    const first = trackReminders({}, [slot({})], 5000, false);
    const next = trackReminders(first, [slot({ remindAt: 65_000 })], 5000, false);
    expect(next.s).toEqual({ remindAt: 65_000, start: 5000 });
    // Unchanged reminders keep their start.
    expect(trackReminders(next, [slot({ remindAt: 65_000 })], 9000, false).s?.start).toBe(5000);
  });

  it('forgets reminders of slots that are no longer running', () => {
    expect(trackReminders({ s: { remindAt: 1, start: 0 } }, [slot({ state: 'ready' })], 0, false)).toEqual({});
  });

  it('clamps progress to 0..1', () => {
    expect(reminderProgress({ start: 10, remindAt: 20 }, 0)).toBe(0);
    expect(reminderProgress({ start: 10, remindAt: 20 }, 99)).toBe(1);
    expect(reminderProgress({ start: 20, remindAt: 20 }, 0)).toBe(1);
  });
});
