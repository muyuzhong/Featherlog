import { animate, motion, type MotionValue, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { type KeyboardEvent, type MouseEvent, type WheelEvent, useEffect, useRef, useState } from 'react';
import {
  cardPose,
  circularOffset,
  hiddenReady,
  placeOf,
  poseTransform,
  restingIndex,
  shortestTarget,
  WHEEL_STEP_MS,
  wrapIndex,
} from '../lib/drum';
import { SPRING } from '../lib/geometry';
import { noticeText } from '../lib/i18n';
import { todoTally } from '../lib/tasks';
import type { WorkSlot } from '../rpc/types';
import { useAppState, useStore, useT } from '../state/react';
import { Elapsed, ReadyTag } from './bits';
import { ChevronDown, ChevronUp, Grip, Plus } from './icons';

/**
 * The always-on bar: a drag grip, the 3D drum of slots, and the way into the
 * workbench. The standalone bar window (?mode=bar) and the browser preview's
 * collapsed state both draw it; only what "open the workbench" means differs.
 */
export function Tray() {
  const store = useStore();
  const { tasks, ui } = useAppState();
  const t = useT();
  const tally = todoTally(tasks);
  const open = store.bar ? ui.panelOpen : ui.expanded;

  return (
    <motion.div
      className="tray"
      data-variant={store.bar ? 'bar' : 'dock'}
      initial={store.bar ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8, transition: { duration: 0.1 } }}
      transition={SPRING}
    >
      <span className="tray-handle" title={t.tray.drag} aria-hidden="true">
        <Grip />
      </span>
      <Drum />
      <div className="tray-quick">
        <button type="button" className="icon-btn" aria-label={t.tray.newSlot} title={t.tray.newSlotHint} onClick={() => store.requestNewSlot()}>
          <Plus />
        </button>
        <button
          type="button"
          className="tray-tally tnum"
          aria-label={t.tray.tally(tally.done, tally.total)}
          title={t.tray.todos}
          onClick={() => store.openTasks()}
        >
          {tally.done}
          <span className="tally-sep">/</span>
          {tally.total}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={open ? t.tray.closePanel : t.tray.openPanel}
          aria-expanded={open}
          title={open ? t.tray.closePanel : t.tray.openPanel}
          onClick={() => void store.togglePanel()}
        >
          {open ? <ChevronDown /> : <ChevronUp />}
        </button>
      </div>
    </motion.div>
  );
}

/**
 * The drum turns along an unbounded position (see lib/drum): the target is
 * React state, so what is in front is known at once; the motion value springs
 * after it and places every card on the cylinder each frame.
 */
function Drum() {
  const store = useStore();
  const { slots, ui } = useAppState();
  const t = useT();
  const n = slots.length;
  const reduce = useReducedMotion();
  const [target, setTarget] = useState(() => restingIndex(slots));
  const pos = useMotionValue(target);
  const anim = useRef<{ stop(): void } | null>(null);
  const anchor = useRef<{ id: string | null; count: number }>({ id: slots[wrapIndex(target, n)]?.id ?? null, count: n });
  const lastWheel = useRef(Number.NEGATIVE_INFINITY);
  const targetRef = useRef(target);

  const moveTo = (next: number, immediate = false) => {
    targetRef.current = next;
    setTarget(next);
    anim.current?.stop();
    anim.current = null;
    if (immediate || reduce) pos.set(next);
    else anim.current = animate(pos, next, SPRING);
  };

  useEffect(() => () => anim.current?.stop(), []);

  // Follow the slots: their count, and the focus the backend reports.
  useEffect(() => {
    const current = targetRef.current;
    const front = wrapIndex(current, n);
    const focus = slots.findIndex((s) => s.state === 'focus');
    if (n === 0) {
      anchor.current = { id: null, count: 0 };
      if (current !== 0) moveTo(0, true);
      return;
    }
    if (n !== anchor.current.count) {
      // A slot came or went: put the card that was in front back in front at once, then roll to the focus.
      const kept = anchor.current.id ? slots.findIndex((s) => s.id === anchor.current.id) : -1;
      const start = kept >= 0 ? kept : restingIndex(slots);
      anchor.current = { id: slots[start]?.id ?? null, count: n };
      moveTo(start, true);
      if (focus >= 0 && focus !== start) moveTo(shortestTarget(start, focus, n));
      return;
    }
    // Without a focus (the front card was just set aside), the drum stays where it is.
    if (focus >= 0 && focus !== front) moveTo(shortestTarget(current, focus, n));
    anchor.current = { id: slots[wrapIndex(targetRef.current, n)]?.id ?? null, count: n };
    // Only the slots move the drum here; moveTo reads its position from refs, so it need not be a dependency.
  }, [slots, n]);

  const frontIdx = wrapIndex(target, n);

  const focusAt = (idx: number) => {
    const slot = slots[idx];
    if (!slot) return;
    anchor.current = { id: slot.id, count: n };
    if (idx !== wrapIndex(targetRef.current, n)) moveTo(shortestTarget(targetRef.current, idx, n));
    if (slot.state !== 'focus') void store.setSlotState(slot.id, 'focus');
  };

  const step = (dir: 1 | -1) => {
    if (n <= 1) return;
    const next = Math.round(targetRef.current) + dir;
    const idx = wrapIndex(next, n);
    const slot = slots[idx];
    anchor.current = { id: slot?.id ?? null, count: n };
    moveTo(next);
    if (slot && slot.state !== 'focus') void store.setSlotState(slot.id, 'focus');
  };

  const onWheel = (e: WheelEvent) => {
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(delta) < 1) return;
    const now = store.clock.now();
    if (now - lastWheel.current < WHEEL_STEP_MS) return;
    lastWheel.current = now;
    step(delta > 0 ? 1 : -1);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      step(-1);
    }
  };

  const onCard = (idx: number) => {
    const slot = slots[idx];
    if (!slot) return;
    if (idx === frontIdx && slot.state === 'focus') void store.togglePanel();
    else focusAt(idx);
  };

  const onMiddle = (slot: WorkSlot) => {
    anchor.current = { id: slot.id, count: n };
    void store.setSlotState(slot.id, slot.state === 'ready' ? 'running' : 'ready');
  };

  const behind = hiddenReady(slots, frontIdx);

  return (
    <div className="drum" data-target={target} data-count={n} onWheel={onWheel} onKeyDown={onKeyDown}>
      {n === 0 ? (
        <button type="button" className="drum-empty" onClick={() => store.requestNewSlot()}>
          {t.tray.empty}
        </button>
      ) : (
        <ol className="drum-cards" aria-label={t.tray.cards}>
          {slots.map((slot, i) => (
            <DrumCard
              key={slot.id}
              slot={slot}
              index={i}
              count={n}
              pos={pos}
              offset={circularOffset(i, target, n)}
              onPick={() => onCard(i)}
              onMiddle={() => onMiddle(slot)}
            />
          ))}
        </ol>
      )}
      {behind.count > 0 && (
        <button
          type="button"
          className="drum-hidden-ready tnum"
          aria-label={t.tray.hiddenReady(behind.count)}
          title={t.tray.toReady}
          onClick={() => focusAt(behind.firstIndex)}
        >
          {t.tray.hiddenReadyChip(behind.count)}
        </button>
      )}
      {ui.notice && (
        <span className="drum-notice" role="status" title={noticeText(t, ui.notice)}>
          {noticeText(t, ui.notice)}
        </span>
      )}
    </div>
  );
}

function DrumCard({
  slot,
  index,
  count,
  pos,
  offset,
  onPick,
  onMiddle,
}: {
  slot: WorkSlot;
  index: number;
  count: number;
  pos: MotionValue<number>;
  /** where the card rests once the drum stops turning */
  offset: number;
  onPick: () => void;
  onMiddle: () => void;
}) {
  const pose = (p: number) => cardPose(circularOffset(index, p, count));
  const transform = useTransform(pos, (p) => poseTransform(pose(p)));
  const opacity = useTransform(pos, (p) => pose(p).opacity);
  const zIndex = useTransform(pos, (p) => pose(p).zIndex);
  const shadeLeft = useTransform(pos, (p) => pose(p).shadeLeft);
  const shadeRight = useTransform(pos, (p) => pose(p).shadeRight);
  const t = useT();
  const place = placeOf(offset);
  const focus = slot.state === 'focus';

  return (
    <motion.li className="drum-card" data-state={slot.state} data-place={place} style={{ transform, opacity, zIndex }}>
      <button
        type="button"
        className="drum-face"
        tabIndex={place === 'back' ? -1 : 0}
        aria-pressed={focus}
        aria-label={t.tray.cardLabel(index + 1, slot.title, t.tray.states[slot.state])}
        title={slot.breadcrumb ? `${slot.title} — ${slot.breadcrumb}` : slot.title}
        onClick={onPick}
        // Middle-click must not start the browser's autoscroll.
        onMouseDown={(e: MouseEvent) => {
          if (e.button === 1) e.preventDefault();
        }}
        onAuxClick={(e: MouseEvent) => {
          if (e.button !== 1) return;
          e.preventDefault();
          onMiddle();
        }}
      >
        {focus && <span className="focus-bar" aria-hidden="true" />}
        <span className="drum-title">{slot.title}</span>
        {slot.state === 'running' && <Elapsed since={slot.stateChangedAt} />}
        {slot.state === 'ready' && <ReadyTag />}
        <motion.span className="drum-shade drum-shade-left" style={{ opacity: shadeLeft }} aria-hidden="true" />
        <motion.span className="drum-shade drum-shade-right" style={{ opacity: shadeRight }} aria-hidden="true" />
      </button>
    </motion.li>
  );
}
