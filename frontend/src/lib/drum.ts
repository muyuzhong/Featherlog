import type { WorkSlot } from '../rpc/types';

/**
 * The 3D drum the bar shows its slots on, as the KDE applet does. The drum
 * turns along an unbounded position: slot i sits at every i + k·n, so going
 * from the last slot to the first is one step forward, never a rewind.
 */

/** Degrees a neighbour stands turned away from the front. */
export const STEP_DEG = 52;
/** How far back a neighbour sits, and how much smaller it looks. */
export const WING_DEPTH = 26;
export const WING_SCALE = 0.84;
/** Front card width and the drum's radius, in px: a neighbour tucks just behind the front. */
export const CARD_WIDTH = 116;
export const DRUM_RADIUS = 100;
/** Cards fade out between these offsets, so the wrap at the back is never seen. */
export const HORIZON_START = 1;
export const HORIZON_END = 1.5;
/** A wheel notch faster than this is the same notch. */
export const WHEEL_STEP_MS = 75;

export function wrapIndex(i: number, n: number): number {
  if (n <= 0) return 0;
  return ((Math.round(i) % n) + n) % n;
}

/** Where slot index sits relative to the drum position: 0 in front, ±1 beside it. */
export function circularOffset(index: number, pos: number, n: number): number {
  if (n <= 1) return index - pos;
  if (n === 2) return pairOffset(index, pos);
  let d = (((index - pos) % n) + n) % n;
  if (d > n / 2) d -= n;
  return d;
}

/**
 * Two slots: a drum of two faces has its other face on both sides at once.
 * The one in front swaps with the one beside it, both on the right, so no
 * card ever jumps from one side to the other.
 */
function pairOffset(index: number, pos: number): number {
  const base = Math.floor(pos);
  const f = pos - base;
  return wrapIndex(base, 2) === index ? f : 1 - f;
}

/** The nearest unbounded target that shows targetIdx in front: N-1 → 0 is +1. */
export function shortestTarget(currentTarget: number, targetIdx: number, n: number): number {
  const base = Math.round(currentTarget);
  if (n <= 1) return base;
  let diff = (targetIdx - base) % n;
  if (diff < 0) diff += n;
  if (diff > n / 2) diff -= n;
  return base + diff;
}

/** The slot the drum faces when nothing turned it: the focus, else the first ready one, else the first. */
export function restingIndex(slots: readonly WorkSlot[]): number {
  const focus = slots.findIndex((s) => s.state === 'focus');
  if (focus >= 0) return focus;
  const ready = slots.findIndex((s) => s.state === 'ready');
  return ready >= 0 ? ready : 0;
}

export interface CardPose {
  /** degrees */
  rotateY: number;
  x: number;
  z: number;
  scale: number;
  opacity: number;
  /** 0..1 shade over the side that curls away */
  shadeLeft: number;
  shadeRight: number;
  zIndex: number;
}

/** A card's place on the cylinder for a (possibly fractional) offset. */
export function cardPose(offset: number): CardPose {
  const a = Math.abs(offset);
  const t = Math.min(a, HORIZON_END);
  const sign = Math.sign(offset);
  const theta = sign * t * STEP_DEG;
  const rad = (theta * Math.PI) / 180;
  let opacity = 1;
  if (a > HORIZON_END) opacity = 0;
  else if (a > HORIZON_START) opacity = 1 - (a - HORIZON_START) / (HORIZON_END - HORIZON_START);
  const wing = Math.min(a, 1);
  return {
    rotateY: round(theta),
    x: round(Math.sin(rad) * DRUM_RADIUS),
    z: round(-WING_DEPTH * t),
    scale: round(1 - (1 - WING_SCALE) * t),
    opacity: round(opacity),
    shadeLeft: round(offset < 0 ? wing : 0),
    shadeRight: round(offset > 0 ? wing : 0),
    zIndex: Math.round(100 - a * 10),
  };
}

export function poseTransform(p: CardPose): string {
  return `translateX(${p.x}px) translateZ(${p.z}px) rotateY(${p.rotateY}deg) scale(${p.scale})`;
}

/** Ready slots out of sight behind the drum (only a drum of 4 or more has a back). */
export function hiddenReady(slots: readonly WorkSlot[], frontIdx: number): { count: number; firstIndex: number } {
  const n = slots.length;
  const out = { count: 0, firstIndex: -1 };
  if (n < 4) return out;
  slots.forEach((slot, i) => {
    if (slot.state !== 'ready' || Math.abs(circularOffset(i, frontIdx, n)) <= 1.2) return;
    out.count += 1;
    if (out.firstIndex < 0) out.firstIndex = i;
  });
  return out;
}

export type CardPlace = 'front' | 'left' | 'right' | 'back';

export function placeOf(offset: number): CardPlace {
  if (Math.abs(offset) < 0.5) return 'front';
  if (Math.abs(offset) > 1.2) return 'back';
  return offset < 0 ? 'left' : 'right';
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000 + 0;
}
