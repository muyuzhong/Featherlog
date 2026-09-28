/** Remembered playground choices (paper, title script). Storage may be unavailable. */
export function loadPreference<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(`featherlog.${key}`) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

export function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(`featherlog.${key}`, value);
  } catch {
    // Private windows may refuse storage; the choice just won't persist.
  }
}
