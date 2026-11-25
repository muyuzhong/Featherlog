import { describe, expect, it } from 'vitest';
import type { WorkSlot } from '../rpc/types';
import { applySlotState, fireDueReminders, focusOf, newlyReady, sortSlots } from './slots';

const slot = (id: string, state: WorkSlot['state'], patch: Partial<WorkSlot> = {}): WorkSlot => ({
  id,
  title: id,
  state,
  breadcrumb: '',
  stateChangedAt: 0,
  order: Number(id.slice(1)),
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

describe('applySlotState', () => {
  const slots = [slot('s1', 'focus'), slot('s2', 'running'), slot('s3', 'ready')];

  it('keeps at most one slot in focus: the old focus goes back to running', () => {
    const next = applySlotState(slots, 's3', 'focus', 500);
    expect(next.map((s) => s.state)).toEqual(['running', 'running', 'focus']);
    expect(next.filter((s) => s.state === 'focus')).toHaveLength(1);
    expect(next[0]?.stateChangedAt).toBe(500);
    expect(next[2]?.stateChangedAt).toBe(500);
  });

  it('keeps the time a slot entered its state when the state does not change', () => {
    const next = applySlotState([slot('s1', 'running', { stateChangedAt: 42 })], 's1', 'running', 900, 10);
    expect(next[0]?.stateChangedAt).toBe(42);
    expect(next[0]?.remindAt).toBe(900 + 10 * 60_000);
  });

  it('sets, keeps and clears a reminder only on running slots', () => {
    const set = applySlotState([slot('s1', 'focus')], 's1', 'running', 0, 20);
    expect(set[0]?.remindAt).toBe(20 * 60_000);
    expect(applySlotState(set, 's1', 'running', 5)[0]?.remindAt).toBe(20 * 60_000);
    expect(applySlotState(set, 's1', 'running', 5, null)[0]).not.toHaveProperty('remindAt');
    expect(applySlotState(set, 's1', 'ready', 5)[0]).not.toHaveProperty('remindAt');
  });

  it('demoting a focus drops nothing it should keep, and writes no undefined', () => {
    const next = applySlotState(slots, 's2', 'focus', 1);
    expect(JSON.stringify(next)).not.toContain('undefined');
    expect(Object.values(next[0]!)).not.toContain(undefined);
  });

  it('rejects an unknown slot', () => {
    expect(() => applySlotState(slots, 'nope', 'focus', 0)).toThrow('workbench/not-found');
  });
});

describe('reminders and helpers', () => {
  it('turns due running slots ready as of their reminder', () => {
    const { slots, fired } = fireDueReminders(
      [slot('s1', 'running', { remindAt: 100 }), slot('s2', 'running', { remindAt: 300 }), slot('s3', 'focus')],
      200,
    );
    expect(fired).toEqual(['s1']);
    expect(slots[0]).toMatchObject({ state: 'ready', stateChangedAt: 100 });
    expect(slots[0]).not.toHaveProperty('remindAt');
    expect(slots[1]?.state).toBe('running');
  });

  it('sorts by order and finds the focus', () => {
    const sorted = sortSlots([slot('s2', 'running'), slot('s1', 'focus')]);
    expect(sorted.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(focusOf(sorted)?.id).toBe('s1');
  });

  it('reports slots that just became ready', () => {
    expect(newlyReady([slot('s1', 'running'), slot('s2', 'ready')], [slot('s1', 'ready'), slot('s2', 'ready'), slot('s9', 'ready')])).toEqual(['s1']);
  });
});
