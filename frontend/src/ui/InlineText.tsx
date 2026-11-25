import { type KeyboardEvent, type Ref, useEffect, useRef, useState } from 'react';

export interface InlineTextProps {
  value: string;
  onCommit: (next: string) => void;
  /** the accessible name */
  label: string;
  placeholder?: string;
  className?: string;
  /** a breadcrumb or a tag may be cleared; a title may not */
  allowEmpty?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  inputRef?: Ref<HTMLInputElement>;
}

/** True while a key belongs to an input method (choosing 汉字), not to us. */
export function isImeKey(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/**
 * Text edited where it is shown, with no dialog: Enter or leaving the field
 * saves, Escape puts the old text back. Changes from the backend show only
 * while the field is not being edited, so they never overwrite typing.
 */
export function InlineText(props: InlineTextProps) {
  const { value, onCommit, label, placeholder, className, allowEmpty = false, autoFocus, maxLength, inputRef } = props;
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = (text: string) => {
    const next = text.trim();
    if (!next && !allowEmpty) {
      setDraft(value);
      return;
    }
    if (next !== value.trim()) onCommit(next);
    setDraft(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelled.current = true;
      setDraft(value);
      e.currentTarget.blur();
    }
  };

  return (
    <input
      ref={inputRef}
      className={className ? `inline ${className}` : 'inline'}
      value={draft}
      aria-label={label}
      placeholder={placeholder}
      maxLength={maxLength}
      autoFocus={autoFocus}
      spellCheck={false}
      autoComplete="off"
      onFocus={() => {
        cancelled.current = false;
        setEditing(true);
      }}
      onBlur={(e) => {
        setEditing(false);
        if (cancelled.current) {
          cancelled.current = false;
          return;
        }
        commit(e.currentTarget.value);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}
