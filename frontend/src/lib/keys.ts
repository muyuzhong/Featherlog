// The keyboard map as one pure function, so the rules are tested in one place
// and the component only performs the action (the way Clipnest's keys.js does).

export type KeyAction =
  | { type: 'focus-slot'; index: number }
  | { type: 'new-slot' }
  | { type: 'toggle-pin' }
  | { type: 'search' }
  | { type: 'escape' };

export interface KeyLike {
  key: string;
  code?: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented?: boolean;
}

export interface KeyContext {
  slotCount: number;
}

/** Alt+digit reads the physical key: on macOS Alt+1 types "¡". */
function digitOf(e: KeyLike): number | null {
  const fromCode = e.code ? /^(?:Digit|Numpad)([1-9])$/.exec(e.code) : null;
  if (fromCode) return Number(fromCode[1]);
  return /^[1-9]$/.test(e.key) ? Number(e.key) : null;
}

export function keyAction(e: KeyLike, ctx: KeyContext): KeyAction | null {
  // Keys that finish an IME composition belong to the IME, not to us.
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return null;
  const command = e.ctrlKey || e.metaKey;
  if (e.altKey && !command && !e.shiftKey) {
    const digit = digitOf(e);
    if (digit !== null) return digit <= ctx.slotCount && !e.repeat ? { type: 'focus-slot', index: digit - 1 } : null;
    if (e.code === 'KeyN' || e.key.toLowerCase() === 'n') return e.repeat ? null : { type: 'new-slot' };
    return null;
  }
  if (command && !e.altKey && !e.shiftKey) {
    const lower = e.key.toLowerCase();
    if (lower === 'p' || e.code === 'KeyP') return e.repeat ? null : { type: 'toggle-pin' };
    if (lower === 'k' || e.code === 'KeyK') return { type: 'search' };
    return null;
  }
  if (e.key === 'Escape' && !command && !e.altKey) return { type: 'escape' };
  return null;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const el = target as HTMLElement;
  return el.isContentEditable || el.closest('input, textarea, select, [contenteditable="true"]') !== null;
}
