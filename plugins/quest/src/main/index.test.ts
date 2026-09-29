import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '@featherlog/kernel';
import type {
  Clock, Envelope, Json, PluginSettings, PluginStorage, Quest, QuestInput, QuestPatch,
  QuestRequests, RequestPayload, ResponseData,
} from '@featherlog/contracts';
import { setup } from './index';
import { dateKey, nextBoundary, periodKey } from './model';

const local = (day: string, hour = 12, minute = 0) => new Date(`${day}T${String(hour)
  .padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).getTime();
const main: QuestInput = {
  kind: 'main', title: 'Learn', chapters: [
    { title: 'One', objectives: [{ text: 'First' }, { text: 'Second', count: { target: 3 } }] },
    { title: 'Two', objectives: [{ text: 'Third' }, { text: 'Fourth', count: { target: 2 } }] },
  ],
};
const daily: QuestInput = { kind: 'daily', title: 'Practice', recurrence: { freq: 'daily' } };

async function fixture(options: {
  now?: number; hour?: number; data?: Map<string, Json>; badgeFails?: boolean;
  missingSetting?: boolean;
} = {}) {
  let time = options.now ?? local('2026-09-28');
  const timers = new Map<() => void, number>();
  const clock: Clock = {
    now: () => time,
    setTimeout(callback, delay) {
      timers.set(callback, time + delay);
      return () => { timers.delete(callback); };
    },
  };
  const data = options.data ?? new Map<string, Json>();
  const storage: PluginStorage = {
    async get<T extends Json>(key: string) {
      return structuredClone(data.get(key)) as T | undefined;
    },
    async set(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { data.delete(key); },
    async keys() { return [...data.keys()]; },
  };
  let hour = options.hour ?? 4;
  const listeners = new Set<(key: string, value: Json | undefined) => void>();
  const settings: PluginSettings = {
    get<T extends Json>() { return options.missingSetting ? undefined : hour as T; },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const kernel = createKernel({
    development: true, clock, log, createServices: () => ({ clock, storage, settings, log }),
  });
  const bus = kernel.createBus('shell');
  const messages: Envelope[] = [];
  const badges: unknown[] = [];
  kernel.observe(message => messages.push(message));
  bus.handle('shell/set-badge', payload => {
    badges.push(payload);
    if (options.badgeFails) throw new Error('badge failed');
    return null;
  });
  await kernel.load([{ manifest: { id: 'quest', name: 'Quest', version: '1.0.0' }, setup }]);
  const failed = messages.find(message => message.type === 'kernel/plugin-failed');
  if (failed) throw new Error(JSON.stringify(failed.payload));
  const request = <K extends keyof QuestRequests>(type: K, payload: RequestPayload<K>) => {
    return bus.request(type, payload) as Promise<ResponseData<K>>;
  };
  const create = async (input: QuestInput = { kind: 'side', title: 'Task' }) => {
    return (await request('quest/create', { input })).quest;
  };
  const get = async (id: string) => (await request('quest/get', { id })).quest;
  const events = () => messages.filter(message => message.kind === 'event' &&
    message.type.startsWith('quest/'));
  return {
    kernel, bus, request, create, get, messages, events, badges, data, storage, timers, log,
    setHour(value: number) {
      hour = value;
      for (const listener of listeners) listener('dayStartHour', value);
    },
    setTime(value: number, fire = true) {
      time = value;
      if (fire) {
        for (const [callback, deadline] of [...timers]) {
          if (deadline <= time && timers.delete(callback)) callback();
        }
      }
    },
    now: () => time,
    listeners,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function command<K extends keyof QuestRequests>(
  f: Fixture, type: K, payload: RequestPayload<K>, expected: string[],
) {
  f.messages.length = 0;
  const response = await f.request(type, payload);
  const id = f.messages.find(message => message.kind === 'request' && message.type === type)!.id;
  expect(f.events().map(message => message.type)).toEqual(expected);
  for (const message of f.events()) expect(message.causedBy).toBe(id);
  for (const message of f.events()) {
    if ('quest' in (message.payload as object)) {
      const snapshot = (message.payload as { quest: Quest }).quest;
      expect(snapshot.derived).toBeDefined();
      if (response && typeof response === 'object' && 'quest' in response) expect(snapshot).toEqual(response.quest);
    }
  }
  return response;
}

describe('§8.1–8.2 creation and validation', () => {
  it('creates all kinds with defaults, timestamps and complete snapshots', async () => {
    const f = await fixture();
    const first = await command(f, 'quest/create', { input: { kind: 'side', title: '  Task  ' } },
      ['quest/created']);
    expect(first.quest).toMatchObject({
      kind: 'side', title: 'Task', priority: 'none', revealed: false, tracked: false,
      status: 'active', order: 0, chapters: [{ title: '', objectives: [] }],
      createdAt: new Date(f.now()).toISOString(), updatedAt: new Date(f.now()).toISOString(),
      derived: { ratio: 0, chapterIndex: 1, objectiveIndex: -1, streak: 0 },
    });
    const second = await f.create({ ...main, name: 'Adventure', story: 'Briefing' });
    expect(second.chapters).toHaveLength(2);
    expect(second.chapters[0]!.objectives[1]!.count).toEqual({ target: 3, current: 0 });
    const third = await f.create(daily);
    expect(third.chapters).toEqual([]);
    expect(third.cycle).toEqual({ periodKey: '2026-09-28', current: 0, done: false });
    expect(new Set([first.quest.id, second.id, third.id]).size).toBe(3);
  });

  const badInputs: unknown[] = [
    null, {}, { kind: 'other', title: 'Task' },
    { kind: 'side', title: '' }, { kind: 'side', title: '   ' },
    { kind: 'side', title: 'x'.repeat(201) }, { kind: 'side', title: 1 },
    { kind: 'side', title: 'Task', name: 'x'.repeat(41) },
    { kind: 'side', title: 'Task', story: 'x'.repeat(2001) },
    { kind: 'main', title: 'Task' }, { ...main, chapters: [] },
    { ...main, chapters: [{ title: 'Empty', objectives: [] }] },
    { kind: 'side', title: 'Task', chapters: main.chapters },
    { kind: 'side', title: 'Task', chapters: [{ title: 'Not empty', objectives: [] }] },
    { ...daily, chapters: [] }, { ...daily, recurrence: null },
    { ...daily, recurrence: { freq: 'weekly', weekdays: [] } },
    { ...daily, recurrence: { freq: 'weekly', weekdays: [1, 1] } },
    { ...daily, recurrence: { freq: 'weekly', weekdays: [-1] } },
    { ...daily, recurrence: { freq: 'weekly', weekdays: [7] } },
    { ...daily, recurrence: { freq: 'weekly', weekdays: [1.5] } },
    { ...daily, recurrence: { freq: 'weekly', weekdays: ['1'] } },
    { ...daily, recurrence: { freq: 'monthly' } },
    { kind: 'side', title: 'Task', recurrence: { freq: 'daily' } },
    { kind: 'side', title: 'Task', quota: { target: 1 } },
    { ...daily, quota: { target: 0 } }, { ...daily, quota: { target: 1.5 } },
    { kind: 'side', title: 'Task', deadline: '2026-02-29' },
    { kind: 'side', title: 'Task', scheduledFor: '2026-13-01' },
    { kind: 'side', title: 'Task', deadline: '2026-9-01' },
    { kind: 'side', title: 'Task', priority: 'urgent' },
    { ...main, chapters: [{ title: 'One', objectives: [{ text: '  ' }] }] },
    { ...main, chapters: [{ title: 'One', objectives: [{ text: 'X', count: { target: -1 } }] }] },
    { ...main, chapters: [{ title: 'One', objectives: [{ text: 'X', count: { target: 1.1 } }] }] },
    { ...main, chapters: [{ id: 'same', title: 'One', objectives: [{ id: 'same', text: 'X' }] }] },
  ];
  it.each(badInputs.map((value, i) => [i, value] as const))('rejects invalid input %i', async (_, value) => {
    const f = await fixture();
    await expect(f.request('quest/create', { input: value as QuestInput }))
      .rejects.toMatchObject({ code: 'quest/invalid-input' });
    expect((await f.request('quest/list', {})).quests).toEqual([]);
    expect(f.events()).toEqual([]);
  });

  it('accepts inclusive text limits, leap dates and weekly Sunday/Saturday', async () => {
    const f = await fixture();
    const quest = await f.create({
      ...daily, title: 'x'.repeat(200), name: 'x'.repeat(40), story: 'x'.repeat(2000),
      deadline: '2024-02-29', scheduledFor: '2026-12-31',
      recurrence: { freq: 'weekly', weekdays: [0, 6] }, quota: { target: 1, unit: 'page' },
    });
    expect(quest.title).toHaveLength(200);
    expect(quest.quota).toEqual({ target: 1, unit: 'page' });
  });
});

describe('§8.3 progression and undo', () => {
  it('unlocks in order, completes chapters and automatically completes/untracks the quest', async () => {
    const f = await fixture();
    let quest = await f.create(main);
    const [a, b] = quest.chapters;
    const [first, second] = a!.objectives;
    const [third, fourth] = b!.objectives;
    await f.request('quest/track', { id: quest.id });
    await expect(f.request('quest/complete-objective', { id: quest.id, objectiveId: third!.id }))
      .rejects.toMatchObject({ code: 'quest/objective-locked' });
    quest = (await command(f, 'quest/complete-objective', { id: quest.id, objectiveId: first!.id },
      ['quest/objective-completed'])).quest;
    expect(quest.derived).toMatchObject({ chapterIndex: 0, objectiveIndex: 1, ratio: .25, chapterRatio: .5 });
    quest = (await command(f, 'quest/count', { id: quest.id, objectiveId: second!.id, delta: 3 },
      ['quest/counted', 'quest/objective-completed', 'quest/chapter-completed'])).quest;
    expect(quest.chapters[0]!.doneAt).toBeDefined();
    expect(quest.derived).toMatchObject({ chapterIndex: 1, objectiveIndex: 0, ratio: .5, chapterRatio: 0 });
    await f.request('quest/complete-objective', { id: quest.id, objectiveId: third!.id });
    quest = (await command(f, 'quest/count', { id: quest.id, objectiveId: fourth!.id, set: 4 },
      ['quest/counted', 'quest/objective-completed', 'quest/chapter-completed',
        'quest/completed', 'quest/tracked'])).quest;
    expect(quest).toMatchObject({ status: 'completed', tracked: false,
      derived: { ratio: 1, chapterRatio: 1, chapterIndex: 2, objectiveIndex: -1 } });
    expect(quest.completedAt).toBeDefined();
    expect(f.events().at(-1)!.payload).toEqual({ questId: null, previous: quest.id });
  });

  it('reopen preserves counts below their targets across chapters', async () => {
    const f = await fixture();
    const initial = await f.create(main);
    await f.request('quest/complete', { id: initial.id });
    const quest = (await command(f, 'quest/reopen-objective', {
      id: initial.id, objectiveId: initial.chapters[0]!.objectives[1]!.id,
    }, ['quest/objective-reopened', 'quest/uncompleted'])).quest;
    expect(quest.status).toBe('active');
    expect(quest.completedAt).toBeUndefined();
    expect(quest.chapters[0]!.objectives[0]!.doneAt).toBeDefined();
    expect(quest.chapters.flatMap(c => c.objectives).slice(1).every(o => !o.doneAt)).toBe(true);
    expect(quest.chapters.every(c => !c.doneAt)).toBe(true);
    expect(quest.chapters[0]!.objectives[1]!.count!.current).toBe(2);
    expect(quest.chapters[1]!.objectives[1]!.count!.current).toBe(1);
    expect(quest.derived.objectiveIndex).toBe(1);
    await command(f, 'quest/reopen-objective', {
      id: quest.id, objectiveId: quest.chapters[0]!.objectives[0]!.id,
    }, ['quest/objective-reopened']);
  });

  it.each([main, { kind: 'side', title: 'One deed' } as QuestInput])(
    'direct completion and undo are idempotent for $kind', async input => {
      const f = await fixture();
      const initial = await f.create(input);
      const quest = (await command(f, 'quest/complete', { id: initial.id }, ['quest/completed'])).quest;
      expect(quest.status).toBe('completed');
      expect(quest.chapters.flatMap(c => c.objectives).every(o => o.doneAt)).toBe(true);
      await command(f, 'quest/complete', { id: quest.id }, []);
      const reopened = (await command(f, 'quest/uncomplete', { id: quest.id }, ['quest/uncompleted'])).quest;
      expect(reopened.status).toBe('active');
      expect(reopened.completedAt).toBeUndefined();
      if (input.kind === 'main') {
        const objectives = reopened.chapters.flatMap(c => c.objectives);
        expect(objectives.slice(0, -1).every(o => o.doneAt)).toBe(true);
        expect(objectives.at(-1)!.doneAt).toBeUndefined();
        expect(objectives.at(-1)!.count!.current).toBe(1);
      }
      await command(f, 'quest/uncomplete', { id: quest.id }, []);
    },
  );

  it('keeps progress for retained objective ids when replacing chapters and never hides data', async () => {
    const f = await fixture();
    let quest = await f.create(main);
    await f.request('quest/complete-objective', { id: quest.id, objectiveId: quest.chapters[0]!.objectives[0]!.id });
    await f.request('quest/count', { id: quest.id, objectiveId: quest.chapters[0]!.objectives[1]!.id, delta: 2 });
    const original = await f.get(quest.id);
    quest = (await command(f, 'quest/set-chapters', {
      id: quest.id, chapters: original.chapters.map(c => ({ ...c, title: `${c.title}!` })),
    }, ['quest/updated'])).quest;
    expect(quest.chapters[0]!.objectives).toEqual(original.chapters[0]!.objectives);
    expect((f.events()[0]!.payload as { changed: string[] }).changed).toEqual(['chapters']);
    expect(quest.revealed).toBe(false);
    expect(quest.chapters[1]!.objectives).toHaveLength(2);
    quest = (await f.request('quest/update', { id: quest.id, patch: { revealed: true } })).quest;
    expect(quest.chapters).toHaveLength(2);
    await expect(f.request('quest/set-chapters', { id: quest.id, chapters: [] }))
      .rejects.toMatchObject({ code: 'quest/invalid-input' });
  });

  it.each([{}, { delta: 1, set: 1 }, { set: -1 }, { delta: .5 }])(
    'validates counting arguments %j', async args => {
      const f = await fixture();
      const quest = await f.create({ ...daily, quota: { target: 3 } });
      await expect(f.request('quest/count', { id: quest.id, ...args }))
        .rejects.toMatchObject({ code: 'quest/invalid-input' });
    },
  );

  it('rejects missing/non-counted/locked objectives and daily counts without quota', async () => {
    const f = await fixture();
    const quest = await f.create(main);
    await expect(f.request('quest/count', { id: quest.id, objectiveId: quest.chapters[1]!.objectives[1]!.id, delta: 1 }))
      .rejects.toMatchObject({ code: 'quest/objective-locked' });
    await expect(f.request('quest/count', { id: quest.id, objectiveId: quest.chapters[0]!.objectives[0]!.id, delta: 1 }))
      .rejects.toMatchObject({ code: 'quest/invalid-input' });
    await expect(f.request('quest/complete-objective', { id: quest.id, objectiveId: 'missing' }))
      .rejects.toMatchObject({ code: 'quest/not-found' });
    const task = await f.create(daily);
    await expect(f.request('quest/count', { id: task.id, delta: 1 }))
      .rejects.toMatchObject({ code: 'quest/invalid-input' });
  });
});

describe('§8.4 tracking and §8.7 events', () => {
  it('tracks only one quest, supports clearing and does not emit for no change', async () => {
    const f = await fixture();
    const first = await f.create();
    const second = await f.create();
    await command(f, 'quest/track', { id: first.id }, ['quest/tracked']);
    await command(f, 'quest/track', { id: first.id }, []);
    await command(f, 'quest/track', { id: second.id }, ['quest/tracked']);
    expect(f.events()[0]!.payload).toEqual({ questId: second.id, previous: first.id });
    expect((await f.get(first.id)).tracked).toBe(false);
    expect((await f.get(second.id)).tracked).toBe(true);
    await command(f, 'quest/track', { id: null }, ['quest/tracked']);
    await command(f, 'quest/track', { id: null }, []);
  });

  it.each(['quest/complete', 'quest/archive', 'quest/delete'] as const)(
    '%s automatically clears tracking after the primary event', async type => {
      const f = await fixture();
      const quest = await f.create();
      await f.request('quest/track', { id: quest.id });
      const primary = { 'quest/complete': 'quest/completed', 'quest/archive': 'quest/updated',
        'quest/delete': 'quest/deleted' }[type];
      await command(f, type, { id: quest.id }, [primary, 'quest/tracked']);
      expect(f.badges.at(-1)).toEqual({ iconId: 'quest/tracker', badge: null });
      if (type !== 'quest/delete') {
        expect((await f.get(quest.id)).tracked).toBe(false);
        await expect(f.request('quest/track', { id: quest.id }))
          .rejects.toMatchObject({ code: 'quest/invalid-input' });
      } else {
        await expect(f.get(quest.id)).rejects.toMatchObject({ code: 'quest/not-found' });
      }
    },
  );

  it('updates badge after ready and each change with the current chapter progress', async () => {
    const f = await fixture();
    expect(f.messages.findIndex(m => m.type === 'kernel/ready')).toBeLessThan(
      f.messages.findIndex(m => m.type === 'shell/set-badge'));
    expect(f.badges[0]).toEqual({ iconId: 'quest/tracker', badge: null });
    const quest = await f.create(main);
    await f.request('quest/track', { id: quest.id });
    await f.request('quest/complete-objective', { id: quest.id, objectiveId: quest.chapters[0]!.objectives[0]!.id });
    expect(f.badges.at(-1)).toEqual({ iconId: 'quest/tracker', badge: { kind: 'progress', value: .5 } });
    await f.request('quest/count', { id: quest.id, objectiveId: quest.chapters[0]!.objectives[1]!.id, delta: 3 });
    expect(f.badges.at(-1)).toEqual({ iconId: 'quest/tracker', badge: { kind: 'progress', value: 0 } });
    const count = f.badges.length;
    await f.get(quest.id);
    expect(f.badges).toHaveLength(count);
  });

  it('only logs badge failures, without failing mutations', async () => {
    const f = await fixture({ badgeFails: true });
    await f.create();
    await f.request('quest/list', {});
    expect(f.log.error).toHaveBeenCalled();
    expect((await f.request('quest/list', {})).quests).toHaveLength(1);
  });

  it('validates update fields, clears optional fields and does not emit unchanged updates', async () => {
    const f = await fixture();
    const quest = await f.create({ kind: 'side', title: 'Task', name: 'Name', deadline: '2026-09-30' });
    await command(f, 'quest/update', { id: quest.id, patch: { title: ' Task ' } }, []);
    const updated = (await command(f, 'quest/update', {
      id: quest.id, patch: { name: null, deadline: null, priority: 'high', story: 'Story' },
    }, ['quest/updated'])).quest;
    expect(updated.name).toBeUndefined();
    expect(updated.deadline).toBeUndefined();
    expect(updated.priority).toBe('high');
    for (const patch of [{ kind: 'daily' }, { title: null }, { title: '' }, { quota: { target: 1 } },
      { revealed: 'yes' }, { chapters: [] }, { name: 'x'.repeat(41) }]) {
      await expect(f.request('quest/update', { id: quest.id, patch: patch as QuestPatch }))
        .rejects.toMatchObject({ code: 'quest/invalid-input' });
    }
    expect((await f.get(quest.id)).title).toBe('Task');
  });
});

describe('§8.5 daily periods, quotas and streaks', () => {
  it('auto-completes quota, uncompletes at target-1, and keeps daily status active', async () => {
    const f = await fixture();
    let quest = await f.create({ ...daily, quota: { target: 3 } });
    quest = (await command(f, 'quest/count', { id: quest.id, delta: 2 }, ['quest/counted'])).quest;
    expect(quest.derived.ratio).toBeCloseTo(2 / 3);
    quest = (await command(f, 'quest/count', { id: quest.id, delta: 3 },
      ['quest/counted', 'quest/completed'])).quest;
    expect(quest).toMatchObject({ status: 'active', tracked: false,
      cycle: { current: 5, done: true }, derived: { ratio: 1, streak: 1 } });
    expect(quest.completedAt).toBeUndefined();
    expect((f.events()[1]!.payload as { periodKey: string }).periodKey).toBe('2026-09-28');
    await command(f, 'quest/complete', { id: quest.id }, []);
    quest = (await command(f, 'quest/uncomplete', { id: quest.id }, ['quest/uncompleted'])).quest;
    expect(quest.cycle!.current).toBe(2);
    expect(quest.derived.streak).toBe(0);
    await command(f, 'quest/uncomplete', { id: quest.id }, []);
    quest = (await command(f, 'quest/complete', { id: quest.id }, ['quest/completed'])).quest;
    expect(quest.cycle!.current).toBe(3);
    quest = (await command(f, 'quest/count', { id: quest.id, set: 1 },
      ['quest/counted', 'quest/uncompleted'])).quest;
    expect(quest.cycle!.done).toBe(false);
    quest = (await f.request('quest/count', { id: quest.id, delta: -10 })).quest;
    expect(quest.cycle!.current).toBe(0);
  });

  it.each([0, 4, 23])('rolls exactly at dayStartHour=%i via the timer, once', async hour => {
    const boundary = local('2026-09-29', hour);
    const f = await fixture({ now: boundary - 1, hour });
    const quest = await f.create(daily);
    expect(quest.cycle!.periodKey).toBe('2026-09-28');
    await f.request('quest/complete', { id: quest.id });
    f.messages.length = 0;
    f.setTime(boundary);
    const after = await f.get(quest.id);
    expect(after.cycle).toEqual({ periodKey: '2026-09-29', current: 0, done: false });
    const rolled = f.events().filter(m => m.type === 'quest/period-rolled');
    expect(rolled).toHaveLength(1);
    expect(rolled[0]!.causedBy).toBeUndefined();
    expect(rolled[0]!.payload).toEqual({ previous: '2026-09-28', current: '2026-09-29' });
    expect(after.derived.streak).toBe(1);
    await f.get(quest.id);
    expect(f.events().filter(m => m.type === 'quest/period-rolled')).toHaveLength(1);
  });

  it('detects laptop sleep on the next request when the timer never ran', async () => {
    const f = await fixture({ now: local('2026-09-28', 23) });
    const quest = await f.create({ ...daily, quota: { target: 1 } });
    await f.request('quest/complete', { id: quest.id });
    f.setTime(local('2026-10-02'), false);
    const result = await command(f, 'quest/get', { id: quest.id }, ['quest/period-rolled']);
    expect(result.quest.cycle).toEqual({ periodKey: '2026-10-02', current: 0, done: false });
    expect(result.quest.derived.streak).toBe(0);
  });

  it('rolls persisted cycles during setup, retaining history and archives', async () => {
    const f = await fixture();
    const quest = await f.create(daily);
    await f.request('quest/complete', { id: quest.id });
    await f.request('quest/archive', { id: quest.id });
    f.kernel.unload('quest');
    const restarted = await fixture({ data: f.data, now: local('2026-09-29') });
    const after = await restarted.get(quest.id);
    expect(after.status).toBe('archived');
    expect(after.cycle).toEqual({ periodKey: '2026-09-29', current: 0, done: false });
    expect(after.derived.streak).toBe(1);
    expect(restarted.events().map(m => m.type)).toEqual(['quest/period-rolled']);
    expect(restarted.events()[0]!.causedBy).toBeUndefined();
  });

  it('recalculates the period and reschedules immediately when dayStartHour changes', async () => {
    const f = await fixture({ now: local('2026-09-29', 3) });
    const quest = await f.create(daily);
    await f.request('quest/complete', { id: quest.id });
    f.setHour(2);
    let after = await f.get(quest.id);
    expect(after.cycle).toEqual({ periodKey: '2026-09-29', current: 0, done: false });
    expect([...f.timers.values()]).toContain(local('2026-09-30', 2));
    f.setHour(4);
    after = await f.get(quest.id);
    expect(after.cycle!.periodKey).toBe('2026-09-28');
    expect(after.cycle!.done).toBe(false);
    expect([...f.timers.values()]).toContain(local('2026-09-29', 4));
    expect(f.events().filter(m => m.type === 'quest/period-rolled')).toHaveLength(2);
  });

  it('counts consecutive daily completions, respects creation period and breaks on a missed day', async () => {
    const f = await fixture();
    const quest = await f.create(daily);
    await f.request('quest/complete', { id: quest.id });
    f.setTime(local('2026-09-29'), false);
    expect((await f.get(quest.id)).derived.streak).toBe(1);
    await f.request('quest/complete', { id: quest.id });
    expect((await f.get(quest.id)).derived.streak).toBe(2);
    f.setTime(local('2026-10-01'), false);
    expect((await f.get(quest.id)).derived.streak).toBe(0);
    expect((await f.get(quest.id)).status).toBe('active');
  });

  it('weekly recurrence crosses weeks and skips non-due days without breaking streak', async () => {
    const f = await fixture({ now: local('2026-09-28') });
    const quest = await f.create({ ...daily, recurrence: { freq: 'weekly', weekdays: [1, 5] } });
    expect(quest.derived.dueToday).toBe(true);
    await f.request('quest/complete', { id: quest.id });
    f.setTime(local('2026-09-29'), false);
    expect((await f.get(quest.id)).derived).toMatchObject({ dueToday: false, streak: 1 });
    f.setTime(local('2026-10-02'), false);
    expect((await f.get(quest.id)).derived).toMatchObject({ dueToday: true, streak: 1 });
    await f.request('quest/complete', { id: quest.id });
    f.setTime(local('2026-10-05'), false);
    expect((await f.get(quest.id)).derived.streak).toBe(2);
    f.setTime(local('2026-10-09'), false);
    expect((await f.get(quest.id)).derived.streak).toBe(0);
  });

  it('uses the shifted weekday before the day boundary', async () => {
    const f = await fixture({ now: local('2026-09-29', 3) });
    const quest = await f.create({ ...daily, recurrence: { freq: 'weekly', weekdays: [1] } });
    expect(quest.cycle!.periodKey).toBe('2026-09-28');
    expect(quest.derived.dueToday).toBe(true);
  });

  it('recomputes quota completion when a quota target changes', async () => {
    const f = await fixture();
    const quest = await f.create({ ...daily, quota: { target: 5 } });
    await f.request('quest/count', { id: quest.id, set: 3 });
    let updated = (await f.request('quest/update', { id: quest.id, patch: { quota: { target: 3 } } })).quest;
    expect(updated.cycle!.done).toBe(true);
    updated = (await f.request('quest/update', { id: quest.id, patch: { quota: { target: 4 } } })).quest;
    expect(updated.cycle!.done).toBe(false);
    await expect(f.request('quest/update', { id: quest.id, patch: { recurrence: null } }))
      .rejects.toMatchObject({ code: 'quest/invalid-input' });
  });
});

describe('§8.6 derived fields, list and reorder', () => {
  it('reads without cloning or writing state and reuses unchanged quest views', async () => {
    const f = await fixture();
    const quest = await f.create(daily);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const write = vi.spyOn(f.storage, 'set');
    try {
      await f.get(quest.id);
      await f.request('quest/list', {});
      expect(write).not.toHaveBeenCalled();
      expect(clone.mock.calls.some(([value]) => value && typeof value === 'object' &&
        ('schemaVersion' in value || 'chapters' in value))).toBe(false);
      const completed = (await f.request('quest/complete', { id: quest.id })).quest;
      expect((await f.get(quest.id)).derived.streak).toBe(1);
      vi.spyOn(f.storage, 'set').mockRejectedValueOnce(new Error('disk full'));
      await expect(f.request('quest/uncomplete', { id: quest.id })).rejects.toThrow('disk full');
      expect(await f.get(quest.id)).toEqual(completed);
      f.setTime(local('2026-09-29'));
      expect((await f.get(quest.id)).cycle?.done).toBe(false);
      expect((await f.get(quest.id)).derived.streak).toBe(1);
    } finally {
      clone.mockRestore();
      write.mockRestore();
    }
  });

  it('groups kinds then sorts by order, filters, and emits only changed orders', async () => {
    const f = await fixture();
    const dailyQuest = await f.create(daily);
    const side = await f.create();
    const a = await f.create(main);
    const b = await f.create(main);
    expect((await f.request('quest/list', {})).quests.map(q => q.id)).toEqual([a.id, b.id, side.id, dailyQuest.id]);
    await command(f, 'quest/reorder', { ids: [b.id, a.id] }, ['quest/updated', 'quest/updated']);
    expect((await f.request('quest/list', { filter: { kind: 'main' } })).quests.map(q => q.id)).toEqual([b.id, a.id]);
    await command(f, 'quest/reorder', { ids: [b.id, a.id] }, []);
    await f.request('quest/archive', { id: side.id });
    expect((await f.request('quest/list', { filter: { status: 'archived' } })).quests.map(q => q.id)).toEqual([side.id]);
    await expect(f.request('quest/reorder', { ids: [a.id, a.id] }))
      .rejects.toMatchObject({ code: 'quest/invalid-input' });
    await expect(f.request('quest/reorder', { ids: [a.id, 'missing'] }))
      .rejects.toMatchObject({ code: 'quest/not-found' });
    expect((await f.get(a.id)).order).toBe(1);
  });

  it('computes dueToday and overdue using period today and active status', async () => {
    const f = await fixture({ now: local('2026-09-28', 1) });
    const a = await f.create({ ...main, deadline: '2026-09-27' });
    const b = await f.create({ kind: 'side', title: 'Side', scheduledFor: '2026-09-28' });
    const future = await f.create({ kind: 'side', title: 'Later', deadline: '2026-09-29' });
    expect(a.derived).toMatchObject({ dueToday: true, overdue: false });
    expect(b.derived).toMatchObject({ dueToday: false, overdue: false });
    expect(future.derived).toMatchObject({ dueToday: false, overdue: false });
    await f.request('quest/complete', { id: a.id });
    await f.request('quest/archive', { id: b.id });
    expect((await f.get(a.id)).derived).toMatchObject({ dueToday: false, overdue: false });
    expect((await f.get(b.id)).derived).toMatchObject({ dueToday: false, overdue: false });
  });

  it('includes fractional count progress in quest and chapter ratios', async () => {
    const f = await fixture();
    const quest = await f.create({ kind: 'main', title: 'Count', chapters: [
      { title: 'One', objectives: [{ text: 'A', count: { target: 4 } }, { text: 'B' }] },
      { title: 'Two', objectives: [{ text: 'C' }, { text: 'D' }] },
    ] });
    const result = await f.request('quest/count', { id: quest.id,
      objectiveId: quest.chapters[0]!.objectives[0]!.id, set: 2 });
    expect(result.quest.derived).toMatchObject({ ratio: .125, chapterRatio: .25, streak: 0 });
  });
});

describe('§5 and §8.8 persistence and resource isolation', () => {
  it('persists schema, quests without derived, history and period; survives restart', async () => {
    const f = await fixture();
    const quest = await f.create(daily);
    await f.request('quest/complete', { id: quest.id });
    const stored = f.data.get('state') as {
      schemaVersion: number; quests: Record<string, Json>[];
      history: Record<string, string[]>; meta: { lastPeriodKey: string };
    };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.quests[0]).not.toHaveProperty('derived');
    expect(stored.history[quest.id]).toEqual(['2026-09-28']);
    expect(stored.meta.lastPeriodKey).toBe('2026-09-28');
    f.kernel.unload('quest');
    expect(f.listeners.size).toBe(0);
    expect(f.timers.size).toBe(0);
    const restarted = await fixture({ data: f.data });
    expect((await restarted.get(quest.id)).cycle!.done).toBe(true);
    await restarted.request('quest/delete', { id: quest.id });
    const saved = restarted.data.get('state') as typeof stored;
    expect(saved.history[quest.id]).toBeUndefined();
  });

  it('serializes concurrent writes and rolls back failed storage writes without events', async () => {
    const f = await fixture();
    const quest = await f.create({ ...daily, quota: { target: 100 } });
    await Promise.all(Array.from({ length: 10 }, () => f.request('quest/count', { id: quest.id, delta: 1 })));
    expect((await f.get(quest.id)).cycle!.current).toBe(10);
    vi.spyOn(f.storage, 'set').mockRejectedValueOnce(new Error('disk full'));
    f.messages.length = 0;
    await expect(f.request('quest/count', { id: quest.id, delta: 1 }))
      .rejects.toMatchObject({ message: 'disk full' });
    expect(f.events()).toEqual([]);
    expect((await f.get(quest.id)).cycle!.current).toBe(10);
    await f.request('quest/count', { id: quest.id, delta: 1 });
    expect((await f.get(quest.id)).cycle!.current).toBe(11);
  });

  it('refuses unsupported storage versions rather than overwriting them', async () => {
    const data = new Map<string, Json>([['state', { schemaVersion: 2 }]]);
    await expect(fixture({ data })).rejects.toThrow('Unsupported quest schemaVersion');
    expect(data.get('state')).toEqual({ schemaVersion: 2 });
  });

  it('uses the local shifted calendar consistently around DST and month/year transitions', () => {
    for (const day of ['2026-01-01', '2026-03-08', '2026-03-29', '2026-11-01', '2027-01-01']) {
      const time = local(day, 12);
      for (const hour of [0, 4, 23]) {
        const boundary = nextBoundary(time, hour);
        expect(boundary).toBeGreaterThan(time);
        expect(periodKey(boundary - 1, hour)).toBe(periodKey(time, hour));
        expect(periodKey(boundary, hour)).not.toBe(periodKey(time, hour));
        expect(periodKey(time, hour)).toBe(dateKey(time - hour * 3_600_000));
      }
    }
  });
});

describe('editing and boundary regressions', () => {
  it('retains accumulated count when lowering an edited target', async () => {
    const f = await fixture();
    const quest = await f.create({ kind: 'main', title: 'Read', chapters: [
      { title: 'One', objectives: [{ text: 'Pages', count: { target: 10 } }] },
    ] });
    const chapter = quest.chapters[0]!;
    const objective = chapter.objectives[0]!;
    await f.request('quest/count', { id: quest.id, objectiveId: objective.id, set: 5 });
    await f.request('quest/track', { id: quest.id });
    const edited = (await command(f, 'quest/set-chapters', { id: quest.id, chapters: [
      { ...chapter, objectives: [{ ...objective, count: { target: 3 } }] },
    ] }, ['quest/updated', 'quest/tracked'])).quest;
    expect(edited.chapters[0]!.objectives[0]!.count!.current).toBe(5);
    expect(edited.chapters[0]!.objectives[0]!.doneAt).toBeDefined();
    expect(edited.status).toBe('completed');
    expect(edited.tracked).toBe(false);
  });

  it('preserves completed objective ids, assigns new ids, and reopens an extended quest', async () => {
    const f = await fixture();
    const quest = await f.create(main);
    await f.request('quest/complete', { id: quest.id });
    const completed = await f.get(quest.id);
    const changed = (await f.request('quest/set-chapters', {
      id: quest.id, chapters: [...completed.chapters, {
        title: 'Extra', objectives: [{ text: 'New objective' }],
      }],
    })).quest;
    expect(changed.status).toBe('active');
    expect(changed.completedAt).toBeUndefined();
    expect(changed.chapters.slice(0, 2)).toEqual(completed.chapters);
    expect(changed.chapters[2]!.id).toBeTruthy();
    expect(changed.derived.chapterIndex).toBe(2);
  });

  it('plain daily completion and undo do not create completedAt or chapters', async () => {
    const f = await fixture();
    const quest = await f.create(daily);
    const complete = (await command(f, 'quest/complete', { id: quest.id }, ['quest/completed'])).quest;
    expect(complete.cycle).toMatchObject({ done: true, current: 0 });
    expect(complete.derived.ratio).toBe(1);
    expect(complete.status).toBe('active');
    expect(complete.completedAt).toBeUndefined();
    expect(complete.chapters).toEqual([]);
    const undone = (await command(f, 'quest/uncomplete', { id: quest.id }, ['quest/uncompleted'])).quest;
    expect(undone.cycle!.done).toBe(false);
    expect(undone.derived.ratio).toBe(0);
    expect(undone.derived.streak).toBe(0);
    await expect(f.request('quest/set-chapters', { id: quest.id, chapters: [] }))
      .rejects.toMatchObject({ code: 'quest/invalid-input' });
  });

  it('quota one uncompletes to zero; no-op counts emit nothing', async () => {
    const f = await fixture();
    const quest = await f.create({ ...daily, quota: { target: 1 } });
    await command(f, 'quest/count', { id: quest.id, delta: 0 }, []);
    await f.request('quest/complete', { id: quest.id });
    expect((await f.request('quest/uncomplete', { id: quest.id })).quest.cycle!.current).toBe(0);
  });

  it('changing quota on an archived daily does not unarchive it', async () => {
    const f = await fixture();
    const quest = await f.create({ ...daily, quota: { target: 2 } });
    await f.request('quest/complete', { id: quest.id });
    await f.request('quest/archive', { id: quest.id });
    const changed = (await f.request('quest/update', { id: quest.id,
      patch: { quota: { target: 3 } } })).quest;
    expect(changed.status).toBe('archived');
    expect(changed.cycle!.done).toBe(false);
    await expect(f.request('quest/complete', { id: quest.id }))
      .rejects.toMatchObject({ code: 'quest/invalid-input' });
  });

  it('rolls before a mutation, then emits its events with the same causedBy', async () => {
    const f = await fixture();
    const quest = await f.create(daily);
    await f.request('quest/complete', { id: quest.id });
    f.setTime(local('2026-09-29'), false);
    await command(f, 'quest/complete', { id: quest.id },
      ['quest/period-rolled', 'quest/completed']);
    expect((await f.get(quest.id)).derived.streak).toBe(2);
  });

  it('settings changes that keep the period still reschedule the next boundary', async () => {
    const f = await fixture();
    const quest = await f.create(daily);
    f.messages.length = 0;
    f.setHour(5);
    expect((await f.get(quest.id)).cycle!.periodKey).toBe('2026-09-28');
    expect(f.events()).toEqual([]);
    expect([...f.timers.values()]).toContain(local('2026-09-29', 5));
    f.setHour(24);
    await f.get(quest.id);
    expect(f.log.error).toHaveBeenCalled();
    expect((await f.get(quest.id)).cycle!.periodKey).toBe('2026-09-28');
  });

  it('retains tracking and progress when reloading in the same period', async () => {
    const f = await fixture();
    const quest = await f.create(main);
    await f.request('quest/track', { id: quest.id });
    await f.request('quest/complete-objective', { id: quest.id,
      objectiveId: quest.chapters[0]!.objectives[0]!.id });
    const before = await f.get(quest.id);
    f.kernel.unload('quest');
    const restarted = await fixture({ data: f.data });
    expect(await restarted.get(quest.id)).toEqual(before);
    expect(restarted.badges.at(-1)).toEqual({
      iconId: 'quest/tracker', badge: { kind: 'progress', value: .5 },
    });
  });

  it('leaves live state mutable only through requests', async () => {
    const f = await fixture();
    const input = structuredClone(main);
    const pending = f.create(input);
    input.chapters![0]!.objectives[0]!.text = 'Caller edit';
    const quest = await pending;
    expect(quest.chapters[0]!.objectives[0]!.text).toBe('First');
    expect(() => { quest.chapters[0]!.objectives[0]!.text = 'Receiver edit'; }).toThrow();
    expect((await f.get(quest.id)).chapters[0]!.objectives[0]!.text).toBe('First');
  });

  it('rejects malformed request shapes and does not coerce enum arrays', async () => {
    const f = await fixture();
    await expect(f.request('quest/create', { input: { kind: ['side'], title: 'X' } as unknown as QuestInput }))
      .rejects.toMatchObject({ code: 'quest/invalid-input' });
    await expect(f.request('quest/create', { input: { kind: 'side', title: 'X', priority: ['high'] } as unknown as QuestInput }))
      .rejects.toMatchObject({ code: 'quest/invalid-input' });
    await expect(f.request('quest/get', null as unknown as { id: string }))
      .rejects.toMatchObject({ code: 'quest/invalid-input' });
    await expect(f.request('quest/list', { filter: { kind: 'bad' } } as unknown as RequestPayload<'quest/list'>))
      .rejects.toMatchObject({ code: 'quest/invalid-input' });
  });
});


it('defaults dayStartHour to four when settings has no value', async () => {
  const f = await fixture({ now: local('2026-09-29', 3), missingSetting: true });
  const quest = await f.create(daily);
  expect(quest.cycle!.periodKey).toBe('2026-09-28');
  expect([...f.timers.values()]).toContain(local('2026-09-29', 4));
});

describe('§8 follow-up rules', () => {
  it.each(['main', 'side'] as const)(
    '%s uses the previous period at 01:00 and advances at 04:00', async kind => {
      const f = await fixture({ now: local('2026-09-28', 1), hour: 4 });
      const base: QuestInput = kind === 'main' ? main : { kind: 'side', title: 'Task' };
      const older = await f.create({ ...base, deadline: '2026-09-26' });
      const previous = await f.create({ ...base, deadline: '2026-09-27' });
      const current = await f.create({ ...base, deadline: '2026-09-28' });
      const scheduled = await f.create({ ...base, scheduledFor: '2026-09-28' });
      const scheduledPrevious = await f.create({ ...base, scheduledFor: '2026-09-27' });
      expect(older.derived).toMatchObject({ dueToday: true, overdue: true });
      expect(previous.derived).toMatchObject({ dueToday: true, overdue: false });
      expect(current.derived).toMatchObject({ dueToday: false, overdue: false });
      expect(scheduled.derived).toMatchObject({ dueToday: false, overdue: false });
      expect(scheduledPrevious.derived).toMatchObject({ dueToday: true, overdue: false });
      f.setTime(local('2026-09-28', 4) - 1, false);
      expect((await f.get(previous.id)).derived.overdue).toBe(false);
      f.setTime(local('2026-09-28', 4), false);
      const listed = (await f.request('quest/list', {})).quests;
      expect(listed.find(q => q.id === previous.id)!.derived.overdue).toBe(true);
      expect(listed.find(q => q.id === current.id)!.derived)
        .toMatchObject({ dueToday: true, overdue: false });
      expect((await f.get(scheduled.id)).derived.dueToday).toBe(true);
    },
  );

  it('applies changed dayStartHour to non-daily dueToday and overdue', async () => {
    const f = await fixture({ now: local('2026-09-28', 1), hour: 4 });
    const previous = await f.create({ kind: 'side', title: 'Previous', deadline: '2026-09-27' });
    const current = await f.create({ kind: 'side', title: 'Current', scheduledFor: '2026-09-28' });
    f.setHour(0);
    expect((await f.get(previous.id)).derived.overdue).toBe(true);
    expect((await f.get(current.id)).derived.dueToday).toBe(true);
    f.setHour(4);
    expect((await f.get(previous.id)).derived.overdue).toBe(false);
    expect((await f.get(current.id)).derived.dueToday).toBe(false);
  });

  it.each([0, 2, 4])('reopen retains unfinished current=%i and earlier progress', async current => {
    const f = await fixture();
    const quest = await f.create({ kind: 'main', title: 'Counts', chapters: [
      { title: 'One', objectives: [{ text: 'Done', count: { target: 3 } }] },
      { title: 'Two', objectives: [{ text: 'Partial', count: { target: 5 } },
        { text: 'Later', count: { target: 1 } }] },
    ] });
    const first = quest.chapters[0]!.objectives[0]!;
    const partial = quest.chapters[1]!.objectives[0]!;
    await f.request('quest/count', { id: quest.id, objectiveId: first.id, set: 9 });
    await f.request('quest/count', { id: quest.id, objectiveId: partial.id, set: current });
    const reopened = (await command(f, 'quest/reopen-objective', {
      id: quest.id, objectiveId: partial.id,
    }, ['quest/objective-reopened'])).quest;
    expect(reopened.chapters[0]!.objectives[0]!.count!.current).toBe(9);
    expect(reopened.chapters[0]!.doneAt).toBeDefined();
    expect(reopened.chapters[1]!.objectives[0]!.count!.current).toBe(current);
    expect(reopened.chapters[1]!.objectives[1]!.count!.current).toBe(0);
    const all = (await f.request('quest/reopen-objective', {
      id: quest.id, objectiveId: first.id,
    })).quest;
    expect(all.chapters[0]!.objectives[0]!.count!.current).toBe(2);
    expect(all.chapters[1]!.objectives[0]!.count!.current).toBe(current);
    expect(all.chapters.every(c => !c.doneAt && c.objectives.every(o => !o.doneAt))).toBe(true);
  });

  it.each([false, true])('rejects daily tracking (completed=%s) without changing existing tracking',
    async completed => {
      const f = await fixture();
      const tracked = await f.create(main);
      const task = await f.create(daily);
      if (completed) await f.request('quest/complete', { id: task.id });
      await f.request('quest/track', { id: tracked.id });
      f.messages.length = 0;
      const saved = structuredClone(f.data);
      const badges = f.badges.length;
      await expect(f.request('quest/track', { id: task.id }))
        .rejects.toMatchObject({ code: 'quest/invalid-input' });
      expect(f.events()).toEqual([]);
      expect(f.data).toEqual(saved);
      expect(f.badges).toHaveLength(badges);
      expect((await f.get(tracked.id)).tracked).toBe(true);
      expect((await f.get(task.id)).tracked).toBe(false);
    },
  );
});
