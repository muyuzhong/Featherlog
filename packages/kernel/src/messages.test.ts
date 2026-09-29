import { expect, it, vi } from 'vitest';
import { assertJson, snapshot } from './messages';

it('rejects holes masked by extra keys, non-enumerable indices and getters without evaluating them', () => {
  const getter = vi.fn(() => 1);
  const hidden = Object.defineProperty([1], '0', { enumerable: false });
  const accessor = Object.defineProperty([1], '0', { get: getter });
  for (const value of [Object.assign(new Array(1), { extra: 1 }),
    Object.assign(new Array(1), { [Symbol()]: 1 }), hidden, accessor]) {
    expect(() => assertJson(value)).toThrow(expect.objectContaining({ code: 'not-json' }));
  }
  expect(getter).not.toHaveBeenCalled();
});

it('copies and freezes a large dense array while retaining JSON alias and cycle rules', () => {
  const original = Array.from({ length: 25_000 }, (_, index) => index);
  const shared = { values: original };
  const copy = snapshot([shared, shared], true);
  expect(copy[0]).toBe(copy[1]);
  expect(copy[0]).not.toBe(shared);
  expect(copy[0]!.values).toEqual(original);
  expect(Object.isFrozen(copy[0]!.values)).toBe(true);
  const cycle: unknown[] = [];
  cycle.push(cycle);
  expect(() => snapshot(cycle, true)).toThrow(expect.objectContaining({ code: 'not-json' }));
});
