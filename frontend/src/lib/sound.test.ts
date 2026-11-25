import { describe, expect, it, vi } from 'vitest';
import { createSoundboard, gainFor } from './sound';

describe('sound', () => {
  it('maps the 0-10 volume to a quiet, squared gain', () => {
    expect(gainFor(0)).toBe(0);
    expect(gainFor(10)).toBeCloseTo(0.32);
    expect(gainFor(5)).toBeCloseTo(0.08);
    expect(gainFor(99)).toBeCloseTo(0.32);
  });

  it('makes no sound, and no AudioContext, when off or silent', () => {
    const ctor = vi.fn();
    const board = createSoundboard(ctor as unknown as new () => AudioContext);
    board.play('tap', { sound: false, volume: 5 });
    board.play('tap', { sound: true, volume: 0 });
    expect(ctor).not.toHaveBeenCalled();
  });

  it('stays quiet without Web Audio', () => {
    expect(() => createSoundboard(undefined).play('done', { sound: true, volume: 5 })).not.toThrow();
  });
});
