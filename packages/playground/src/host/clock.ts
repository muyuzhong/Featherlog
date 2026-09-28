import type { Clock } from '@featherlog/contracts';
import { load, save } from './persist';

const DAY = 86_400_000;

/** Real time plus a number of simulated days, so "next day" can be tested without waiting. */
export function createDevClock() {
  let days = Number(load('dayOffset') ?? 0);
  const clock: Clock = {
    now: () => Date.now() + days * DAY,
    setTimeout(callback, ms) {
      const timer = window.setTimeout(callback, ms);
      return () => window.clearTimeout(timer);
    },
  };
  return {
    clock,
    nextDay() {
      days += 1;
      save('dayOffset', String(days));
    },
  };
}

/** The quest plugin's notion of "today" (design §8.5): the date `dayStartHour` hours ago. */
export function periodKey(now: number, dayStartHour = 4, plusDays = 0): string {
  const d = new Date(now - dayStartHour * 3_600_000 + plusDays * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
