// Everything the playground keeps between reloads lives under this prefix.
const PREFIX = 'featherlog.dev.';
const memory = new Map<string, string>();

export function load(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return memory.get(key) ?? null;
  }
}

export function save(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, value);
  } catch {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
}

export function keysUnder(key: string): string[] {
  try {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX + key))
      .map((k) => k.slice(PREFIX.length));
  } catch {
    return [...memory.keys()].filter((k) => k.startsWith(key));
  }
}

/** Forget every playground key: quests, settings, the simulated date. */
export function clearAll(): void {
  for (const key of keysUnder('')) save(key, null);
}
