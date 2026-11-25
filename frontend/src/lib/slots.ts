import type { WorkSlot, WorkSlotState } from '../rpc/types';
import { omitUndefined } from './json';

export const MINUTE_MS = 60_000;

export function sortSlots(slots: readonly WorkSlot[]): WorkSlot[] {
  return [...slots].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

export function focusOf(slots: readonly WorkSlot[]): WorkSlot | undefined {
  return slots.find((s) => s.state === 'focus');
}

/**
 * The rule setState follows on both sides of the bridge: at most one slot is
 * in focus, and focusing one sends the old focus back to running. A reminder
 * only lives on a running slot; remindInMinutes null clears it, a number sets
 * it from now, and leaving it out keeps the one there is.
 */
export function applySlotState(
  slots: readonly WorkSlot[],
  id: string,
  state: WorkSlotState,
  now: number,
  remindInMinutes?: number | null,
): WorkSlot[] {
  if (!slots.some((s) => s.id === id)) throw new Error(`workbench/not-found: ${id}`);
  return slots.map((slot) => {
    if (slot.id === id) {
      let remindAt = slot.remindAt;
      if (state !== 'running' || remindInMinutes === null) remindAt = undefined;
      else if (typeof remindInMinutes === 'number' && remindInMinutes > 0) remindAt = now + remindInMinutes * MINUTE_MS;
      return omitUndefined({
        ...slot,
        state,
        remindAt,
        stateChangedAt: slot.state === state ? slot.stateChangedAt : now,
        updatedAt: now,
      });
    }
    if (state === 'focus' && slot.state === 'focus') {
      return omitUndefined({ ...slot, state: 'running' as const, remindAt: undefined, stateChangedAt: now, updatedAt: now });
    }
    return slot;
  });
}

/** Running slots whose reminder is due turn ready, as of the moment it fell due. */
export function fireDueReminders(slots: readonly WorkSlot[], now: number): { slots: WorkSlot[]; fired: string[] } {
  const fired: string[] = [];
  const next = slots.map((slot) => {
    if (slot.state !== 'running' || slot.remindAt == null || slot.remindAt > now) return slot;
    fired.push(slot.id);
    return omitUndefined({ ...slot, state: 'ready' as const, stateChangedAt: slot.remindAt, remindAt: undefined, updatedAt: now });
  });
  return { slots: next, fired };
}

/** Slots that became ready between two lists, for the "回来看" cue. */
export function newlyReady(prev: readonly WorkSlot[], next: readonly WorkSlot[]): string[] {
  const before = new Map(prev.map((s) => [s.id, s.state]));
  return next.filter((s) => s.state === 'ready' && before.has(s.id) && before.get(s.id) !== 'ready').map((s) => s.id);
}
