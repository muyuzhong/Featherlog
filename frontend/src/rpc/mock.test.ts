import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../lib/clock';
import { MIN, T0 } from '../test/fixtures';
import { LocalMockBridge, MOCK_STORAGE_KEY, seedData, type KeyValueStorage } from './mock';
import type { BridgeEvents, WorkSlot } from './types';

const flush = () => new Promise((r) => setTimeout(r, 0));

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function make(options: { seed?: boolean; start?: number; storage?: KeyValueStorage | null } = {}) {
  const clock = new ManualClock(options.start ?? T0);
  const bridge = new LocalMockBridge({ clock, storage: options.storage ?? null, seed: options.seed });
  return { clock, bridge };
}

function listen<E extends keyof BridgeEvents>(bridge: LocalMockBridge, event: E) {
  const seen: BridgeEvents[E][] = [];
  bridge.on(event, (p) => seen.push(p));
  return seen;
}

describe('seed', () => {
  it('starts with three slots in flight: one focus, one running with a reminder, one ready', async () => {
    const { bridge } = make();
    const slots = await bridge.workbench.list();
    expect(slots.map((s) => s.state)).toEqual(['focus', 'running', 'ready']);
    expect(slots[1]?.remindAt).toBeGreaterThan(T0);
    const { tasks, periodKey } = await bridge.tasks.list();
    expect(periodKey).toBe('2026-11-25');
    // Plain todos and a couple that reset daily: no main quests any more.
    expect(new Set(tasks.map((t) => t.kind))).toEqual(new Set(['side', 'daily']));
    expect(tasks.filter((t) => t.status === 'active').every((t) => t.dueToday || t.overdue)).toBe(true);
    expect(tasks.some((t) => t.quota)).toBe(true);
    expect((await bridge.notes.list()).length).toBeGreaterThanOrEqual(3);
  });

  it('is plain JSON, with no undefined anywhere', () => {
    const data = seedData(T0);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });
});

describe('WorkbenchService', () => {
  it('focusing a slot sends the old focus back to running and returns the whole list', async () => {
    const { bridge, clock } = make();
    clock.advance(MIN);
    const slots = await bridge.workbench.setState({ id: 's-3', state: 'focus' });
    expect(slots.map((s) => [s.id, s.state])).toEqual([
      ['s-1', 'running'],
      ['s-2', 'running'],
      ['s-3', 'focus'],
    ]);
    expect(slots[0]?.stateChangedAt).toBe(T0 + MIN);
  });

  it('a reminder turns a running slot ready when it falls due, and tells the page', async () => {
    const { bridge, clock } = make({ seed: false });
    const events = listen(bridge, 'workbench:changed');
    const slot = await bridge.workbench.create({ title: '等 CI', state: 'running' });
    await bridge.workbench.setState({ id: slot.id, state: 'running', remindInMinutes: 10 });
    clock.advance(9 * MIN);
    expect((await bridge.workbench.list())[0]?.state).toBe('running');
    clock.advance(MIN + 1000);
    await flush();
    const [after] = await bridge.workbench.list();
    expect(after).toMatchObject({ state: 'ready', stateChangedAt: T0 + 10 * MIN });
    expect(after).not.toHaveProperty('remindAt');
    expect(events.at(-1)?.[0]?.state).toBe('ready');
  });

  it('creates at the end, defaults to running, and requires a title', async () => {
    const { bridge } = make();
    const created = await bridge.workbench.create({ title: '  跑基准  ', tag: ' perf ' });
    expect(created).toMatchObject({ title: '跑基准', tag: 'perf', state: 'running', breadcrumb: '', order: 3 });
    await expect(bridge.workbench.create({ title: '   ' })).rejects.toThrow('workbench/title-required');
    await expect(bridge.workbench.create({ title: 'x', linkedTaskId: 'nope' })).rejects.toThrow('workbench/task-not-found');
  });

  it('creating in focus demotes the old focus', async () => {
    const { bridge } = make();
    const created = await bridge.workbench.create({ title: '新的', state: 'focus' });
    const slots = await bridge.workbench.list();
    expect(slots.filter((s) => s.state === 'focus').map((s) => s.id)).toEqual([created.id]);
  });

  it('updates the breadcrumb, clears a tag and unlinks a task', async () => {
    const { bridge } = make();
    const slot = await bridge.workbench.update({ id: 's-1', breadcrumb: '  下一步：接 RPC ', tag: '', linkedTaskId: null });
    expect(slot.breadcrumb).toBe('下一步：接 RPC');
    expect(slot).not.toHaveProperty('tag');
    expect(slot).not.toHaveProperty('linkedTaskId');
  });

  it('completing can complete the linked task too', async () => {
    const { bridge } = make();
    const tasksSeen = listen(bridge, 'tasks:changed');
    const slots = await bridge.workbench.complete({ id: 's-1', completeLinkedTask: true });
    expect(slots.map((s) => s.id)).toEqual(['s-2', 's-3']);
    const t1 = (await bridge.tasks.list()).tasks.find((t) => t.id === 't-1');
    expect(t1?.status).toBe('completed');
    await flush();
    expect(tasksSeen).toHaveLength(1);
  });

  it('completing alone leaves the task open', async () => {
    const { bridge } = make();
    await bridge.workbench.complete({ id: 's-1' });
    expect((await bridge.tasks.list()).tasks.find((t) => t.id === 't-1')?.status).toBe('active');
  });

  it('reorders', async () => {
    const { bridge } = make();
    const slots = await bridge.workbench.reorder({ ids: ['s-3', 's-1'] });
    expect(slots.map((s) => s.id)).toEqual(['s-3', 's-1', 's-2']);
  });

  it('replies with copies: changing a reply changes nothing stored', async () => {
    const { bridge } = make();
    const [first] = await bridge.workbench.list();
    (first as WorkSlot).title = 'mutated';
    expect((await bridge.workbench.list())[0]?.title).not.toBe('mutated');
  });
});

describe('TaskService', () => {
  it('ticks items in any order', async () => {
    const { bridge } = make();
    await bridge.tasks.toggleItem({ taskId: 't-1', itemId: 'i-4' });
    const t = await bridge.tasks.toggleItem({ taskId: 't-1', itemId: 'i-2', done: true });
    expect(t.items.map((i) => i.done)).toEqual([true, true, false, true]);
  });

  it('steps a count up to its target, which completes the task', async () => {
    const { bridge } = make();
    let t = await bridge.tasks.stepQuota({ id: 't-7', delta: 1 });
    expect(t.quota).toEqual({ current: 2, target: 3 });
    for (let i = 0; i < 10; i++) t = await bridge.tasks.stepQuota({ id: 't-7', delta: 1 });
    expect(t.quota?.current).toBe(3);
    expect(t.status).toBe('completed');
    expect(t.streak).toBe(10);
    t = await bridge.tasks.stepQuota({ id: 't-7', delta: -1 });
    expect(t.status).toBe('active');
    await expect(bridge.tasks.stepQuota({ id: 't-3', delta: 1 })).rejects.toThrow('task/no-quota');
  });

  it('creates daily tasks for this period, and today\'s side tasks as due', async () => {
    const { bridge } = make({ seed: false });
    const daily = await bridge.tasks.create({ kind: 'daily', title: '背单词', quotaTarget: 30 });
    expect(daily).toMatchObject({ recurrence: { freq: 'daily' }, periodKey: '2026-11-25', streak: 0, dueToday: true });
    expect(daily.quota).toEqual({ current: 0, target: 30 });
    const side = await bridge.tasks.create({ kind: 'side', title: '回邮件', scheduledFor: '2026-11-25', items: [{ text: '甲' }, { text: ' ' }] });
    expect(side.dueToday).toBe(true);
    expect(side.items).toHaveLength(1);
  });

  it('rewrites items, keeping the ids it is given', async () => {
    const { bridge } = make();
    const t = await bridge.tasks.setItems({ id: 't-1', items: [{ id: 'i-3', text: '双栏' }, { text: '新的一步' }] });
    expect(t.items.map((i) => i.id)).toEqual(['i-3', expect.stringMatching(/^i-/)]);
    expect(t.items[1]).toMatchObject({ text: '新的一步', done: false });
  });

  it('clears a deadline and a quota with null', async () => {
    const { bridge } = make();
    const t = await bridge.tasks.update({ id: 't-2', deadline: null, quotaTarget: null, title: '读完' });
    expect(t).not.toHaveProperty('quota');
    expect(t).not.toHaveProperty('deadline');
    expect(t.title).toBe('读完');
  });

  it('supports omitted/task kind on create, in-place recurrence toggle on update, and flat reorder', async () => {
    const { bridge } = make({ seed: false });
    const plain = await bridge.tasks.create({ title: '普通待办' });
    expect(plain).toMatchObject({ kind: 'side', title: '普通待办' });
    expect(plain).not.toHaveProperty('recurrence');

    const dailyFromRec = await bridge.tasks.create({ kind: 'task', title: '每日巡检', recurrence: { freq: 'daily' } });
    expect(dailyFromRec).toMatchObject({ kind: 'daily', recurrence: { freq: 'daily' }, dueToday: true });

    const promoted = await bridge.tasks.update({ id: plain.id, recurrence: { freq: 'daily' } });
    expect(promoted).toMatchObject({ id: plain.id, kind: 'daily', recurrence: { freq: 'daily' }, periodKey: '2026-11-25' });

    const demoted = await bridge.tasks.update({ id: plain.id, recurrence: null });
    expect(demoted).toMatchObject({ id: plain.id, kind: 'side' });
    expect(demoted).not.toHaveProperty('recurrence');
    expect(demoted).not.toHaveProperty('periodKey');

    const reordered = await bridge.tasks.reorder({ ids: [dailyFromRec.id, plain.id] });
    expect(reordered.map((t) => t.id)).toEqual([dailyFromRec.id, plain.id]);
  });

  it('deleting a task lets go of its notes and slots', async () => {
    const { bridge } = make();
    await bridge.tasks.delete({ id: 't-1' });
    expect((await bridge.tasks.list()).tasks.some((t) => t.id === 't-1')).toBe(false);
    expect((await bridge.notes.list()).find((n) => n.id === 'n-1')?.taskId).toBeNull();
    expect((await bridge.workbench.list())[0]).not.toHaveProperty('linkedTaskId');
  });

  it('starts a new period at dayStartHour: daily counts reset, streaks kept', async () => {
    const { bridge, clock } = make({ start: new Date(2026, 10, 25, 23, 0).getTime() });
    const seen = listen(bridge, 'tasks:changed');
    for (let i = 0; i < 2; i++) await bridge.tasks.stepQuota({ id: 't-7', delta: 1 });
    clock.advance(4 * 60 * MIN); // 03:00 next day: still the 25th's period
    expect((await bridge.tasks.list()).periodKey).toBe('2026-11-25');
    clock.advance(60 * MIN + 1000); // 04:00:01
    await flush();
    const list = await bridge.tasks.list();
    expect(list.periodKey).toBe('2026-11-26');
    const prs = list.tasks.find((t) => t.id === 't-7');
    expect(prs).toMatchObject({ status: 'active', quota: { current: 0, target: 3 }, streak: 10, periodKey: '2026-11-26' });
    // Yesterday's finished todo leaves today's list.
    expect(list.tasks.find((t) => t.id === 't-8')?.dueToday).toBe(false);
    expect(seen.at(-1)?.periodKey).toBe('2026-11-26');
  });
});

describe('NoteService', () => {
  it('lists everything, loose notes only, one task\'s notes, or what matches', async () => {
    const { bridge } = make();
    const all = await bridge.notes.list();
    expect(all.map((n) => n.createdAt)).toEqual([...all.map((n) => n.createdAt)].sort((a, b) => b - a));
    expect((await bridge.notes.list({ taskId: null })).every((n) => n.taskId === null)).toBe(true);
    expect((await bridge.notes.list({ taskId: 't-1' })).map((n) => n.id)).toEqual(['n-1']);
    expect((await bridge.notes.list({ query: '待看' })).map((n) => n.id)).toEqual(['n-4']);
    expect(await bridge.notes.list({ limit: 2 })).toHaveLength(2);
  });

  it('creates, edits and deletes, telling the page each time', async () => {
    const { bridge, clock } = make({ seed: false });
    const seen = listen(bridge, 'notes:changed');
    const note = await bridge.notes.create({ content: '  一句话  ' });
    expect(note).toMatchObject({ content: '一句话', taskId: null });
    clock.advance(1000);
    const edited = await bridge.notes.update({ id: note.id, content: '两句话' });
    expect(edited.updatedAt).toBe(T0 + 1000);
    await bridge.notes.delete({ id: note.id });
    await flush();
    expect(seen.map((s) => s.reason)).toEqual(['created', 'updated', 'deleted']);
    await expect(bridge.notes.create({ content: ' ' })).rejects.toThrow('notes/content-required');
  });
});

describe('settings, dock and storage', () => {
  it('clamps settings and announces them', async () => {
    const { bridge } = make();
    const seen = listen(bridge, 'settings:changed');
    const s = await bridge.settings.update({ volume: 42, dayStartHour: -3, theme: 'graphite', pinned: true });
    expect(s).toEqual({ theme: 'graphite', volume: 10, dayStartHour: 0, sound: true, pinned: true, barMode: 'auto' });
    await flush();
    expect(seen).toHaveLength(1);
  });

  it('keeps the bar mode and where the bar was dragged, and forgets the place on null', async () => {
    const { bridge } = make();
    expect((await bridge.settings.get()).barMode).toBe('auto');
    let s = await bridge.settings.update({ barMode: 'standalone', barX: 120.6, barY: 1040 });
    expect(s).toMatchObject({ barMode: 'standalone', barX: 121, barY: 1040 });
    s = await bridge.settings.update({ barMode: 'nonsense' as never });
    expect(s.barMode).toBe('standalone');
    s = await bridge.settings.update({ barX: null, barY: null });
    expect(s).not.toHaveProperty('barX');
    expect(s).not.toHaveProperty('barY');
    expect(s.barMode).toBe('standalone');
  });

  it('DockService.Toggle flips the workbench window, or sets it, and tells every window', async () => {
    const { bridge } = make();
    const seen = listen(bridge, 'dock:toggle');
    expect(await bridge.dock.toggle()).toEqual({ expanded: true });
    expect(await bridge.dock.toggle()).toEqual({ expanded: false });
    expect(await bridge.dock.toggle({ expanded: true })).toEqual({ expanded: true });
    expect(await bridge.dock.toggle({ expanded: true })).toEqual({ expanded: true });
    expect(bridge.panelOpen).toBe(true);
    await flush();
    expect(seen).toEqual([{ expanded: true }, { expanded: false }, { expanded: true }, { expanded: true }]);
  });

  it('records the geometry asked for and a quit', async () => {
    const { bridge } = make();
    await bridge.dock.resize({ width: 880, height: 520, expanded: true });
    await bridge.dock.quit();
    expect(bridge.lastGeometry).toEqual({ width: 880, height: 520, expanded: true });
    expect(bridge.quitRequested).toBe(true);
  });

  it('keeps everything in storage across instances', async () => {
    const storage = memoryStorage();
    const { bridge } = make({ storage });
    await bridge.workbench.update({ id: 's-2', breadcrumb: '记住我' });
    bridge.dispose();
    const again = make({ storage }).bridge;
    expect((await again.workbench.list())[1]?.breadcrumb).toBe('记住我');
    expect(storage.data.has(MOCK_STORAGE_KEY)).toBe(true);
  });

  it('reads settings saved before barMode existed as "auto"', async () => {
    const storage = memoryStorage();
    const first = make({ storage, seed: false }).bridge;
    first.dispose();
    const saved = JSON.parse(storage.data.get(MOCK_STORAGE_KEY)!) as { settings: Record<string, unknown> };
    delete saved.settings.barMode;
    storage.setItem(MOCK_STORAGE_KEY, JSON.stringify(saved));
    expect((await make({ storage }).bridge.settings.get()).barMode).toBe('auto');
  });

  it('falls back to the seed when storage holds garbage', async () => {
    const storage = memoryStorage();
    storage.setItem(MOCK_STORAGE_KEY, '{not json');
    expect(await make({ storage }).bridge.workbench.list()).toHaveLength(3);
  });

  it('emits dock:toggle like the host shortcut', async () => {
    const { bridge } = make();
    const fn = vi.fn();
    bridge.on('dock:toggle', fn);
    bridge.toggleDock();
    bridge.toggleDock(true);
    await flush();
    expect(fn.mock.calls).toEqual([[{}], [{ expanded: true }]]);
  });
});
