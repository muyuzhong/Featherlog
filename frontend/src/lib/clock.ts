// Every timer in the app goes through an injected Clock, so tests can move
// time by hand and the mock backend can fire reminders deterministically.

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): () => void;
  setInterval(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const id = globalThis.setTimeout(fn, ms);
    return () => globalThis.clearTimeout(id);
  },
  setInterval(fn, ms) {
    const id = globalThis.setInterval(fn, ms);
    return () => globalThis.clearInterval(id);
  },
};

interface ManualTimer {
  id: number;
  at: number;
  every: number | null;
  fn: () => void;
}

/** A clock that only moves when told to. */
export class ManualClock implements Clock {
  #now: number;
  #timers: ManualTimer[] = [];
  #seq = 0;

  constructor(start: number) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): () => void {
    return this.#add(fn, ms, null);
  }

  setInterval(fn: () => void, ms: number): () => void {
    return this.#add(fn, ms, Math.max(1, ms));
  }

  /** Moves time forward, running every timer that falls due, in order. */
  advance(ms: number): void {
    const end = this.#now + Math.max(0, ms);
    for (;;) {
      let next: ManualTimer | undefined;
      for (const t of this.#timers) {
        if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
      }
      if (!next) break;
      this.#now = next.at;
      if (next.every === null) this.#timers = this.#timers.filter((t) => t !== next);
      else next.at += next.every;
      next.fn();
    }
    this.#now = end;
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }

  #add(fn: () => void, ms: number, every: number | null): () => void {
    const timer: ManualTimer = { id: ++this.#seq, at: this.#now + Math.max(0, ms), every, fn };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((t) => t !== timer);
    };
  }
}
