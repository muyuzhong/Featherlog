import type { CharacterSheet, ChronicleEntry, UiBus, UiSound } from '@featherlog/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createCharacterStore } from './store';

const sheet: CharacterSheet = { attributes: [], unassigned: 0, titles: [], worn: null };
const at = (n: number) => new Date(Date.UTC(2026, 9, 5, 12, 0, n)).toISOString();
const rank = (id: string, second: number): ChronicleEntry =>
  ({ id, at: at(second), kind: 'rank', attribute: 'learning', rank: 1, rankName: '初涉' });

/** A bus with canned answers; `emit` delivers an event to the store's listeners. */
function fakeBus(answers: Record<string, (req: Record<string, unknown>) => unknown>) {
  const listeners = new Map<string, (payload: unknown) => void>();
  const bus = {
    request: vi.fn(async (type: string, req: Record<string, unknown>) => {
      const answer = answers[type];
      if (!answer) throw Object.assign(new Error('no handler'), { code: 'kernel/no-handler' });
      return answer(req);
    }),
    on: vi.fn((type: string, listener: (payload: unknown) => void) => {
      listeners.set(type, listener);
      return () => listeners.delete(type);
    }),
  };
  return { bus: bus as unknown as UiBus, request: bus.request, emit: (type: string, payload: unknown) => listeners.get(type)?.(payload) };
}

const sound: UiSound = { play: vi.fn() } as unknown as UiSound;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('character store', () => {
  it('pages back by time and keeps entries that arrive later at the top', async () => {
    let page = [rank('c', 3), rank('b', 2)];
    const { bus, emit } = fakeBus({
      'character/sheet': () => sheet,
      'character/chronicle': (req) => (req.before ? { entries: [rank('b', 2), rank('a', 1)], more: false } : { entries: page, more: true }),
    });
    const store = createCharacterStore(bus, sound);
    await settle();
    expect(store.getSnapshot().chronicle.map((e) => e.id)).toEqual(['c', 'b']);

    await store.loadMore();
    expect(store.getSnapshot().chronicle.map((e) => e.id)).toEqual(['c', 'b', 'a']);
    expect(store.getSnapshot().more).toBe(false);

    page = [rank('d', 4), rank('c', 3)];
    emit('character/changed', { sheet: { ...sheet, unassigned: 5 } });
    await settle();
    expect(store.getSnapshot().sheet?.unassigned).toBe(5);
    expect(store.getSnapshot().chronicle.map((e) => e.id)).toEqual(['d', 'c', 'b', 'a']);
    // What was already paged in stays; the newest page alone must not bring "more" back.
    expect(store.getSnapshot().more).toBe(false);
  });

  it('asks for an epilogue once, and settles on none without 翎', async () => {
    const { bus, request } = fakeBus({ 'character/sheet': () => sheet, 'character/chronicle': () => ({ entries: [], more: false }) });
    const store = createCharacterStore(bus, sound);
    store.epilogue('q1');
    store.epilogue('q1');
    await settle();
    expect(store.getSnapshot().epilogues.get('q1')).toBeNull();
    expect(request.mock.calls.filter(([type]) => type === 'scribe/epilogue')).toHaveLength(1);
  });

  it('takes the first line of 翎\'s epilogue', async () => {
    const { bus } = fakeBus({
      'character/sheet': () => sheet,
      'character/chronicle': () => ({ entries: [], more: false }),
      'scribe/epilogue': () => ({ epilogue: { questId: 'q1', text: '\n三卷读罢，书架空了一格。\n第二行', writtenAt: at(0) } }),
    });
    const store = createCharacterStore(bus, sound);
    store.epilogue('q1');
    await settle();
    expect(store.getSnapshot().epilogues.get('q1')).toBe('三卷读罢，书架空了一格。');
  });

  it('seals only when putting a title on', async () => {
    const play = vi.fn();
    const { bus } = fakeBus({
      'character/sheet': () => sheet,
      'character/chronicle': () => ({ entries: [], more: false }),
      'character/wear': (req) => ({ ...sheet, worn: req.titleId }),
    });
    const store = createCharacterStore(bus, { play } as unknown as UiSound);
    await store.wear('first-stroke');
    expect(store.getSnapshot().sheet?.worn).toBe('first-stroke');
    await store.wear(null);
    expect(play.mock.calls).toEqual([['seal']]);
  });
});
