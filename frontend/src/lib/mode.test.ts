import { describe, expect, it } from 'vitest';
import { detectMode } from './mode';

describe('detectMode', () => {
  it('is the panel inside MyGo, whichever runtime global is there', () => {
    expect(detectMode({ mygo: {} }, '')).toBe('panel');
    expect(detectMode({ __FEATHERLOG_MYGO__: {} }, '')).toBe('panel');
  });

  it('is the panel in a browser tab with ?mode=panel', () => {
    expect(detectMode({}, '?mode=panel')).toBe('panel');
    expect(detectMode({}, '?theme=x&mode=panel')).toBe('panel');
  });

  it('is the bottom bar and drawer in a plain browser tab', () => {
    expect(detectMode({}, '')).toBe('dock');
    expect(detectMode({}, '?mode=dock')).toBe('dock');
    expect(detectMode({ mygo: null }, '?mode=Panel')).toBe('dock');
  });
});
