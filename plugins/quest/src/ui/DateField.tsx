import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { cn, cnDate, localToday } from './numerals';
import styles from './date-field.module.css';

const DIGITS = '〇一二三四五六七八九';
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

const pad = (n: number) => String(n).padStart(2, '0');
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};
const addDays = (day: string, n: number) => {
  const d = parse(day);
  d.setDate(d.getDate() + n);
  return key(d);
};
/** Monday = 0 … Sunday = 6. */
const weekdayOf = (day: string) => (parse(day).getDay() + 6) % 7;
const year = (y: number) => [...String(y)].map((c) => DIGITS[Number(c)]).join('');

/** "2026-10-31" → 十月三十一日 · 周六 */
export const cnDay = (day: string) => `${cnDate(day)} · 周${WEEKDAYS[weekdayOf(day)]}`;

type Props = {
  value: string;
  onChange(value: string): void;
  label: string;
  /** What an empty value reads as. */
  emptyText?: string;
};

/**
 * A date written in the journal's hand, with a small calendar that unfolds in
 * the page (design §10): the platform's date popup belongs to another world.
 */
export function DateField({ value, onChange, label, emptyText = '不设限期' }: Props) {
  const today = localToday();
  const [open, setOpen] = useState(false);
  const calendar = useRef<HTMLDivElement>(null);
  const [month, setMonth] = useState(() => (value || today).slice(0, 7));

  const pick = (day: string) => {
    onChange(day);
    setOpen(false);
  };
  const toggle = () => {
    if (!open) setMonth((value || today).slice(0, 7));
    setOpen(!open);
  };
  const shift = (n: number) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y!, m! - 1 + n, 1);
    setMonth(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };

  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const lead = weekdayOf(first);
  const daysInMonth = new Date(y!, m!, 0).getDate();
  const cells = Array.from({ length: Math.ceil((lead + daysInMonth) / 7) * 7 }, (_, i) => addDays(first, i - lead));
  const sunday = addDays(today, 6 - weekdayOf(today));
  const monthEnd = key(new Date(parse(today).getFullYear(), parse(today).getMonth() + 1, 0));
  const quick: [string, string][] = [
    ['今天', today],
    ['明天', addDays(today, 1)],
    ['这周日', sunday],
    ['下周日', addDays(sunday, 7)],
    ['月底', monthEnd],
  ];

  return (
    <div className={styles.field} onKeyDown={onKey}>
      <button className={`${styles.value} ${value ? '' : styles.empty}`} aria-label={label} aria-expanded={open} onClick={toggle}>
        {value ? cnDay(value) : emptyText}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className={styles.calendar}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 0.8, 0.32, 1] }}
            // Unfolded near the foot of a page, the calendar brings itself into view.
            onAnimationComplete={(definition) => {
              if (typeof definition === 'object' && definition !== null && 'height' in definition && definition.height === 'auto') {
                calendar.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              }
            }}
            ref={calendar}
          >
            <div className={styles.inner}>
              <div className={styles.head}>
                <button aria-label="上个月" onClick={() => shift(-1)}>
                  ‹
                </button>
                <span>
                  {year(y!)}年{cn(m!)}月
                </span>
                <button aria-label="下个月" onClick={() => shift(1)}>
                  ›
                </button>
              </div>
              <div className={styles.grid} role="grid" aria-label={label}>
                {WEEKDAYS.map((w) => (
                  <span key={w} className={styles.weekday}>
                    {w}
                  </span>
                ))}
                {cells.map((day) => {
                  const classes = [
                    styles.day,
                    day.slice(0, 7) !== month ? styles.outside : '',
                    day < today ? styles.past : '',
                    day === today ? styles.today : '',
                    day === value ? styles.chosen : '',
                  ].join(' ');
                  return (
                    <button key={day} className={classes} aria-pressed={day === value} aria-label={cnDay(day)} onClick={() => pick(day)}>
                      {Number(day.slice(8))}
                    </button>
                  );
                })}
              </div>
              <div className={styles.quick}>
                {quick.map(([text, day]) => (
                  <button key={text} onClick={() => pick(day)}>
                    {text}
                  </button>
                ))}
                {value && (
                  <button className={styles.clear} onClick={() => pick('')}>
                    {emptyText}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
