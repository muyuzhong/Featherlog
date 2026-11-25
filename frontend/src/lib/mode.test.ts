import { describe, expect, it } from 'vitest';
import { detectMode } from './mode';

describe('detectMode', () => {
  it('reads ?mode= first, inside MyGo or not', () => {
    expect(detectMode({}, '?mode=bar')).toBe('bar');
    expect(detectMode({}, '?mode=panel')).toBe('panel');
    expect(detectMode({}, '?mode=dock')).toBe('dock');
    expect(detectMode({ mygo: {} }, '?mode=bar')).toBe('bar');
    expect(detectMode({ __FEATHERLOG_MYGO__: {} }, '?mode=dock')).toBe('dock');
    expect(detectMode({}, '?theme=x&mode=bar')).toBe('bar');
  });

  it('is the panel inside MyGo without a mode, whichever runtime global is there', () => {
    expect(detectMode({ mygo: {} }, '')).toBe('panel');
    expect(detectMode({ __FEATHERLOG_MYGO__: {} }, '')).toBe('panel');
    expect(detectMode({ mygo: {} }, '?mode=drum')).toBe('panel');
  });

  it('is the dock in a plain browser tab without a valid mode', () => {
    expect(detectMode({}, '')).toBe('dock');
    expect(detectMode({}, '?mode=Panel')).toBe('dock');
    expect(detectMode({}, '?mode=')).toBe('dock');
    expect(detectMode({ mygo: null }, '?mode=BAR')).toBe('dock');
  });
});
