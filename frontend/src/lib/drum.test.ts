import { describe, expect, it } from 'vitest';
import type { WorkSlot } from '../rpc/types';
import {
  cardPose,
  circularOffset,
  hiddenReady,
  placeOf,
  poseTransform,
  restingIndex,
  shortestTarget,
  STEP_DEG,
  WING_DEPTH,
  WING_SCALE,
  wrapIndex,
} from './drum';

const slot = (id: string, state: WorkSlot['state']): WorkSlot => ({
  id,
  title: id,
  state,
  breadcrumb: '',
  stateChangedAt: 0,
  order: 0,
  createdAt: 0,
  updatedAt: 0,
});

describe('drum positions', () => {
  it('wraps any unbounded position to a slot index', () => {
    expect(wrapIndex(5, 5)).toBe(0);
    expect(wrapIndex(-1, 5)).toBe(4);
    expect(wrapIndex(-6, 5)).toBe(4);
    expect(wrapIndex(3, 0)).toBe(0);
  });

  it('turns the shortest way round: N-1 → 0 is one step forward, 0 → N-1 one step back', () => {
    expect(shortestTarget(4, 0, 5)).toBe(5);
    expect(shortestTarget(5, 4, 5)).toBe(4);
    expect(shortestTarget(0, 4, 5)).toBe(-1);
    expect(shortestTarget(12, 1, 5)).toBe(11);
    expect(shortestTarget(2.6, 3, 5)).toBe(3);
    expect(shortestTarget(7, 0, 1)).toBe(7);
  });

  it('places neighbours at ±1 and the rest behind, continuously through a wrap', () => {
    // Five slots, drum on slot 0: 4 is on the left, 1 on the right.
    expect([0, 1, 2, 3, 4].map((i) => circularOffset(i, 0, 5))).toEqual([0, 1, 2, -2, -1]);
    // Turning from 4 to 5 (= slot 0 again) moves slot 0 in from the right, never across the back.
    expect(circularOffset(0, 4.5, 5)).toBeCloseTo(0.5);
    expect(circularOffset(4, 4.5, 5)).toBeCloseTo(-0.5);
    expect(circularOffset(0, 5, 5)).toBe(0);
  });

  it('with two slots, swaps them on the right so no card jumps sides', () => {
    expect([circularOffset(0, 0, 2), circularOffset(1, 0, 2)]).toEqual([0, 1]);
    expect([circularOffset(0, 0.25, 2), circularOffset(1, 0.25, 2)]).toEqual([0.25, 0.75]);
    expect([circularOffset(0, 1, 2), circularOffset(1, 1, 2)]).toEqual([1, 0]);
    expect([circularOffset(0, 1.5, 2), circularOffset(1, 1.5, 2)]).toEqual([0.5, 0.5]);
  });

  it('rests on the focus, else the first ready slot, else the first', () => {
    expect(restingIndex([slot('a', 'running'), slot('b', 'focus'), slot('c', 'ready')])).toBe(1);
    expect(restingIndex([slot('a', 'running'), slot('b', 'ready')])).toBe(1);
    expect(restingIndex([slot('a', 'running')])).toBe(0);
    expect(restingIndex([])).toBe(0);
  });
});

describe('card poses', () => {
  it('stands the front card flat and full', () => {
    expect(cardPose(0)).toEqual({ rotateY: 0, x: 0, z: 0, scale: 1, opacity: 1, shadeLeft: 0, shadeRight: 0, zIndex: 100 });
    expect(poseTransform(cardPose(0))).toBe('translateX(0px) translateZ(0px) rotateY(0deg) scale(1)');
  });

  it('curls a neighbour back: rotateY ±52deg, translateZ(-26px), scale(0.84), shaded on its far side', () => {
    const right = cardPose(1);
    const left = cardPose(-1);
    expect(right).toMatchObject({ rotateY: STEP_DEG, z: -WING_DEPTH, scale: WING_SCALE, opacity: 1, shadeRight: 1, shadeLeft: 0 });
    expect(left).toMatchObject({ rotateY: -STEP_DEG, z: -WING_DEPTH, scale: WING_SCALE, opacity: 1, shadeLeft: 1, shadeRight: 0 });
    expect(right.x).toBeGreaterThan(0);
    expect(left.x).toBe(-right.x);
    expect(right.zIndex).toBeLessThan(cardPose(0).zIndex);
    expect(poseTransform(right)).toContain('rotateY(52deg)');
    expect(poseTransform(left)).toContain('translateZ(-26px)');
  });

  it('fades cards out between offset 1 and 1.5, so the back never shows', () => {
    expect(cardPose(1.25).opacity).toBeCloseTo(0.5);
    expect(cardPose(1.5).opacity).toBe(0);
    expect(cardPose(-2).opacity).toBe(0);
  });

  it('names where a card rests', () => {
    expect([0, 0.3, -1, 1, 2, -1.5].map(placeOf)).toEqual(['front', 'front', 'left', 'right', 'back', 'back']);
  });
});

describe('hiddenReady', () => {
  it('counts ready slots out of sight behind a drum of four or more', () => {
    const slots = [slot('a', 'focus'), slot('b', 'running'), slot('c', 'ready'), slot('d', 'ready'), slot('e', 'running')];
    // Front 0: 4 and 1 are beside it; 2 and 3 are behind.
    expect(hiddenReady(slots, 0)).toEqual({ count: 2, firstIndex: 2 });
    // Front 3: 2 is beside it and visible, nothing ready behind.
    expect(hiddenReady(slots, 3)).toEqual({ count: 0, firstIndex: -1 });
  });

  it('has nothing behind with three slots or fewer', () => {
    expect(hiddenReady([slot('a', 'focus'), slot('b', 'ready'), slot('c', 'ready')], 0).count).toBe(0);
  });
});
