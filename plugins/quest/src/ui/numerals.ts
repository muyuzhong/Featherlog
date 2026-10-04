const DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const CAPITALS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖', '拾'];

/** 7 → 七, 12 → 十二, 28 → 二十八. Falls back to digits from 100 on. */
export function cn(n: number): string {
  if (n < 10) return DIGITS[n]!;
  if (n < 20) return `十${n % 10 ? DIGITS[n % 10] : ''}`;
  if (n < 100) return `${DIGITS[Math.floor(n / 10)]}十${n % 10 ? DIGITS[n % 10] : ''}`;
  return String(n);
}

/** For counting things (before a measure word): 2 → 两, otherwise as `cn`. */
export function cnCount(n: number): string {
  return n === 2 ? '两' : cn(n);
}

/** Chapter numerals: 1 → 壹. */
export function capital(n: number): string {
  return n <= 10 ? CAPITALS[n]! : cn(n);
}

/** "2026-09-30" → 九月三十日 */
export function cnDate(localDate: string): string {
  const [, month, day] = localDate.slice(0, 10).split('-').map(Number);
  return `${cn(month!)}月${cn(day!)}日`;
}

export function localToday(dayStartHour = 4): string {
  const d = new Date(Date.now() - dayStartHour * 3_600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole days between two dates, inclusive of the first: the journey's day number. */
export function dayNumber(since: string, today: string): number {
  return Math.round((Date.parse(today.slice(0, 10)) - Date.parse(since.slice(0, 10))) / 86_400_000) + 1;
}

/** How a deadline reads against today: past, today, or the date it is due by. */
export function dueState(deadline: string, today: string): 'overdue' | 'today' | 'ahead' {
  return deadline < today ? 'overdue' : deadline === today ? 'today' : 'ahead';
}
