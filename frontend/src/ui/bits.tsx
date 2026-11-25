import { motion } from 'motion/react';
import type { MouseEvent, ReactNode } from 'react';
import { SPRING } from '../lib/geometry';
import { formatElapsed } from '../lib/time';
import { useNow } from '../state/react';
import { Check, Minus, Plus } from './icons';

/** The one loud mark: a printed, inverted bookmark label. Nothing glows. */
export function ReadyTag() {
  return (
    <span className="ready-tag" title="跑完了，等你接手">
      待看
    </span>
  );
}

export function Elapsed({ since, prefix }: { since: number; prefix?: string }) {
  const now = useNow(1000);
  return (
    <span className="elapsed tnum">
      {prefix}
      {formatElapsed(now - since)}
    </span>
  );
}

export function Checkbox({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className="check"
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <Check />
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** the accessible name when the label is an icon */
  name?: string;
  count?: number;
}

export function Segmented<T extends string>({
  id,
  label,
  options,
  value,
  onChange,
  compact,
}: {
  id: string;
  label: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  compact?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={compact ? 'seg seg-compact' : 'seg'}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.name}
            title={o.name}
            className="seg-item"
            onClick={() => onChange(o.value)}
          >
            {on && <motion.span layoutId={`${id}-plate`} className="seg-plate" transition={SPRING} />}
            <span className="seg-label">{o.label}</span>
            {o.count !== undefined && o.count > 0 && <span className="seg-count tnum">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** [ − 2 / 5 + ]: a click on the count adds one, a right-click takes one away. */
export function QuotaStepper({
  current,
  target,
  onStep,
  label,
}: {
  current: number;
  target: number;
  onStep: (delta: 1 | -1) => void;
  label: string;
}) {
  const full = current >= target;
  const step = (delta: 1 | -1) => (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onStep(delta);
  };
  return (
    <span className="quota" role="group" aria-label={`${label} ${current}/${target}`} data-full={full || undefined}>
      <button type="button" aria-label={`${label}减一`} className="quota-step" onClick={step(-1)} disabled={current <= 0}>
        <Minus />
      </button>
      <button
        type="button"
        className="quota-count tnum"
        aria-label={`${label}加一（右键减一）`}
        onClick={step(1)}
        onContextMenu={step(-1)}
      >
        {current}
        <span className="quota-sep">/</span>
        {target}
      </button>
      <button type="button" aria-label={`${label}加一`} className="quota-step" onClick={step(1)} disabled={full}>
        <Plus />
      </button>
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}
