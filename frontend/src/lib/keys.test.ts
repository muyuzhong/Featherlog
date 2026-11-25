import { describe, expect, it } from 'vitest';
import { isTypingTarget, keyAction, type KeyLike } from './keys';

const key = (patch: Partial<KeyLike>): KeyLike => ({
  key: '',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...patch,
});

describe('keyAction', () => {
  const ctx = { slotCount: 3 };

  it('Alt+1..9 focuses that slot, reading the physical key', () => {
    expect(keyAction(key({ altKey: true, key: '2', code: 'Digit2' }), ctx)).toEqual({ type: 'focus-slot', index: 1 });
    // macOS types ¡ for Alt+1.
    expect(keyAction(key({ altKey: true, key: '¡', code: 'Digit1' }), ctx)).toEqual({ type: 'focus-slot', index: 0 });
    expect(keyAction(key({ altKey: true, key: '4', code: 'Digit4' }), ctx)).toBeNull();
    expect(keyAction(key({ altKey: true, key: '2', code: 'Digit2', repeat: true }), ctx)).toBeNull();
  });

  it('Alt+N opens a new slot', () => {
    expect(keyAction(key({ altKey: true, key: 'n', code: 'KeyN' }), ctx)).toEqual({ type: 'new-slot' });
    expect(keyAction(key({ altKey: true, key: '˜', code: 'KeyN' }), ctx)).toEqual({ type: 'new-slot' });
  });

  it('Ctrl+P pins and Ctrl+K searches, on Cmd too', () => {
    expect(keyAction(key({ ctrlKey: true, key: 'p', code: 'KeyP' }), ctx)).toEqual({ type: 'toggle-pin' });
    expect(keyAction(key({ metaKey: true, key: 'p', code: 'KeyP' }), ctx)).toEqual({ type: 'toggle-pin' });
    expect(keyAction(key({ ctrlKey: true, key: 'k', code: 'KeyK' }), ctx)).toEqual({ type: 'search' });
    expect(keyAction(key({ ctrlKey: true, shiftKey: true, key: 'P', code: 'KeyP' }), ctx)).toBeNull();
  });

  it('Escape asks to step back', () => {
    expect(keyAction(key({ key: 'Escape' }), ctx)).toEqual({ type: 'escape' });
  });

  it('leaves keys of an IME composition alone', () => {
    expect(keyAction(key({ key: 'Escape', isComposing: true }), ctx)).toBeNull();
    expect(keyAction(key({ altKey: true, key: '1', code: 'Digit1', keyCode: 229 }), ctx)).toBeNull();
    expect(keyAction(key({ ctrlKey: true, key: 'p', defaultPrevented: true }), ctx)).toBeNull();
  });

  it('ignores plain typing', () => {
    expect(keyAction(key({ key: '1', code: 'Digit1' }), ctx)).toBeNull();
    expect(keyAction(key({ key: 'n' }), ctx)).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('knows fields from the rest of the page', () => {
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const div = document.createElement('div');
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(area)).toBe(true);
    expect(isTypingTarget(div)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
