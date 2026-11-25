import { describe, expect, it, vi } from 'vitest';
import { SETTLE_MS } from '../lib/geometry';
import { flush, MIN, setup, T0 } from '../test/fixtures';
import { resolvedTheme, themeChoiceOf } from './store';

describe('AppStore', () => {
  it('loads slots, tasks, settings and notes, and sizes the collapsed dock', async () => {
    const { store, bridge } = setup();
    await store.init();
    const s = store.getState();
    expect(s.ready).toBe(true);
    expect(s.slots).toHaveLength(3);
    expect(s.periodKey).toBe('2026-11-25');
    expect(s.notes.length).toBeGreaterThan(0);
    expect(bridge.lastGeometry).toEqual({ width: 646, height: 44, expanded: false, pinned: false });
    // The seeded reminder counts from when its slot started running.
    expect(s.reminders['s-2']).toEqual({ remindAt: T0 + 6 * MIN, start: T0 - 14 * MIN });
  });

  it('grows the window before expanding and shrinks it only after collapsing', async () => {
    const { store, bridge, clock } = setup();
    await store.init();
    store.setExpanded(true);
    expect(bridge.lastGeometry).toMatchObject({ width: 880, height: 520, expanded: true });
    store.setExpanded(false);
    expect(bridge.lastGeometry).toMatchObject({ width: 880, height: 520 });
    clock.advance(SETTLE_MS);
    expect(bridge.lastGeometry).toMatchObject({ width: 646, height: 44, expanded: false });
  });

  it('switches focus at once and settles on the backend\'s answer', async () => {
    const { store } = setup();
    await store.init();
    const pending = store.setSlotState('s-3', 'focus');
    expect(store.getState().slots.map((s) => s.state)).toEqual(['running', 'running', 'focus']);
    await pending;
    expect(store.getState().slots.filter((s) => s.state === 'focus').map((s) => s.id)).toEqual(['s-3']);
  });

  it('Alt+N-style focusSlotAt picks by position and ignores a missing slot', async () => {
    const { store } = setup();
    await store.init();
    await store.focusSlotAt(1);
    expect(store.getState().slots[1]?.state).toBe('focus');
    await store.focusSlotAt(7);
    expect(store.getState().slots.filter((s) => s.state === 'focus')).toHaveLength(1);
  });

  it('sets a reminder and starts its hairline from now', async () => {
    const { store, clock } = setup();
    await store.init();
    clock.advance(MIN);
    await store.setSlotState('s-1', 'running', 20);
    expect(store.getState().reminders['s-1']).toEqual({ remindAt: T0 + 21 * MIN, start: T0 + MIN });
  });

  it('cues the ready sound when the backend turns a slot ready', async () => {
    const { store, clock, cues } = setup();
    await store.init();
    clock.advance(6 * MIN + 1000);
    await flush();
    expect(store.getState().slots[1]?.state).toBe('ready');
    expect(cues).toContain('ready');
  });

  it('上台: a task becomes the focus slot, linked to it, and is reused the second time', async () => {
    const { store } = setup();
    await store.init();
    await store.promoteTask('t-3');
    const slots = store.getState().slots;
    const promoted = slots.find((s) => s.linkedTaskId === 't-3');
    expect(promoted).toMatchObject({ title: '给 clipnest 提 Linux 托盘的 issue', state: 'focus' });
    expect(slots.filter((s) => s.state === 'focus')).toHaveLength(1);
    expect(store.getState().ui.highlightSlotId).toBe(promoted?.id);
    await store.setSlotState('s-2', 'focus');
    await store.promoteTask('t-3');
    expect(store.getState().slots.filter((s) => s.linkedTaskId === 't-3')).toHaveLength(1);
    expect(store.getState().slots.find((s) => s.linkedTaskId === 't-3')?.state).toBe('focus');
  });

  it('focus notes follow the focus slot\'s task, or the task picked on the left', async () => {
    const { store } = setup();
    await store.init();
    store.setNotesScope('focus');
    await flush();
    expect(store.getState().notes.map((n) => n.id)).toEqual(['n-1']);
    store.selectTask('t-2');
    await flush();
    expect(store.getState().notes.map((n) => n.id)).toEqual(['n-3']);
    store.selectTask(null);
    await store.setSlotState('s-2', 'focus');
    await flush();
    // s-2 has no task: there is nothing to hang notes on.
    expect(store.notesFilter()).toBeNull();
    expect(store.getState().notes).toEqual([]);
  });

  it('new notes in focus scope hang on the context task', async () => {
    const { store, bridge } = setup();
    await store.init();
    store.setNotesScope('focus');
    expect(await store.createNote('  接口先按契约写  ')).toBe(true);
    const mine = (await bridge.notes.list({ taskId: 't-1' })).map((n) => n.content);
    expect(mine).toContain('接口先按契约写');
    expect(await store.createNote('   ')).toBe(false);
  });

  it('debounces the notes search through the clock', async () => {
    const { store, clock, bridge } = setup();
    await store.init();
    const list = vi.spyOn(bridge.notes, 'list');
    store.setNotesQuery('待');
    store.setNotesQuery('待看');
    expect(list).not.toHaveBeenCalled();
    clock.advance(200);
    await flush();
    expect(list).toHaveBeenCalledTimes(1);
    expect(store.getState().notes.map((n) => n.id)).toEqual(['n-4']);
  });

  it('shows a notice when a call fails, and puts the old state back', async () => {
    const { store, bridge, clock } = setup();
    await store.init();
    vi.spyOn(bridge.workbench, 'setState').mockRejectedValueOnce(new Error('workbench/busy'));
    await store.setSlotState('s-2', 'focus');
    expect(store.getState().ui.notice).toBe('切换状态失败：workbench/busy');
    expect(store.getState().slots[0]?.state).toBe('focus');
    clock.advance(4000);
    expect(store.getState().ui.notice).toBeNull();
  });

  it('steps a quota optimistically and cues completion', async () => {
    const { store, cues } = setup();
    await store.init();
    for (let i = 0; i < 2; i++) await store.stepQuota('t-7', 1);
    expect(store.getState().tasks.find((t) => t.id === 't-7')).toMatchObject({ status: 'completed', quota: { current: 3 } });
    expect(cues.at(-1)).toBe('done');
  });

  it('collapses on Escape or blur only while unpinned', async () => {
    const { store } = setup();
    await store.init();
    store.setExpanded(true);
    await store.togglePin();
    expect(store.collapseIfUnpinned()).toBe(false);
    expect(store.getState().ui.expanded).toBe(true);
    await store.togglePin();
    expect(store.collapseIfUnpinned()).toBe(true);
    expect(store.getState().ui.expanded).toBe(false);
  });

  it('follows the dock:toggle event of the global shortcut', async () => {
    const { store, bridge } = setup();
    await store.init();
    bridge.toggleDock();
    await flush();
    expect(store.getState().ui.expanded).toBe(true);
    bridge.toggleDock(true);
    await flush();
    expect(store.getState().ui.expanded).toBe(true);
    bridge.toggleDock();
    await flush();
    expect(store.getState().ui.expanded).toBe(false);
  });

  it('themes: the backend\'s, or the desktop\'s while following the system', async () => {
    const { store } = setup();
    await store.init();
    expect(resolvedTheme(store.getState())).toBe('stone');
    store.setThemeChoice('graphite');
    await flush();
    expect(store.getState().settings.theme).toBe('graphite');
    store.setThemeChoice('system');
    store.setSystemDark(false);
    expect(themeChoiceOf(store.getState())).toBe('system');
    expect(resolvedTheme(store.getState())).toBe('stone');
    store.setSystemDark(true);
    expect(resolvedTheme(store.getState())).toBe('graphite');
  });

  describe('每日重置 (in-place via TaskService.Update)', () => {
    it('turns a plain todo into a daily one in place, keeping id, items, slot link and notes', async () => {
      const { store, bridge } = setup();
      await store.init();
      await store.toggleItem('t-1', 'i-3', true);
      store.selectTask('t-1');
      const noteBefore = (await bridge.notes.list({ taskId: 't-1' }))[0];
      const update = vi.spyOn(bridge.tasks, 'update');

      await store.setDailyReset('t-1', true);

      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith({ id: 't-1', recurrence: { freq: 'daily' }, deadline: null });
      const { tasks } = await bridge.tasks.list();
      const daily = tasks.find((t) => t.id === 't-1');
      expect(daily).toMatchObject({ id: 't-1', kind: 'daily', recurrence: { freq: 'daily' }, status: 'active', dueToday: true });
      expect(daily).not.toHaveProperty('deadline');
      expect(daily?.items.map((i) => [i.text, i.done])).toEqual([
        ['收起态交给 Plasmoid', true],
        ['面板铺满不透明窗口', false],
        ['Esc / 失焦隐藏弹窗', true],
        ['和 Go 宿主联调 Resize', false],
      ]);
      // The focus slot and note stay attached to the same task id and keep original timestamps.
      expect((await bridge.workbench.list()).find((s) => s.id === 's-1')?.linkedTaskId).toBe('t-1');
      expect((await bridge.notes.list({ taskId: 't-1' }))[0]).toEqual(noteBefore);
      expect(store.getState().ui.selectedTaskId).toBe('t-1');
      expect(store.getState().tasks.find((t) => t.id === 't-1')?.kind).toBe('daily');
    });

    it('turns a daily one back into a plain todo in place, keeping id, count and completion', async () => {
      const { store, bridge } = setup();
      await store.init();
      for (let i = 0; i < 2; i++) await store.stepQuota('t-7', 1);
      const update = vi.spyOn(bridge.tasks, 'update');

      await store.setDailyReset('t-7', false);

      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith({ id: 't-7', recurrence: null });
      const plain = (await bridge.tasks.list()).tasks.find((t) => t.id === 't-7');
      expect(plain).toMatchObject({ id: 't-7', kind: 'side', status: 'completed', quota: { current: 3, target: 3 } });
      expect(plain).not.toHaveProperty('recurrence');
    });

    it('leaves the old task untouched and shows a notice when Update fails', async () => {
      const { store, bridge } = setup();
      await store.init();
      vi.spyOn(bridge.tasks, 'update').mockRejectedValueOnce(new Error('tasks/busy'));
      await store.setDailyReset('t-1', true);
      expect(store.getState().ui.notice).toBe('切换每日重置失败：tasks/busy');
      expect((await bridge.tasks.list()).tasks.find((t) => t.id === 't-1')?.kind).toBe('side');
      expect((await bridge.notes.list({ taskId: 't-1' })).length).toBe(1);
    });

    it('does nothing when the task already is what was asked', async () => {
      const { store, bridge } = setup();
      await store.init();
      const update = vi.spyOn(bridge.tasks, 'update');
      await store.setDailyReset('t-1', false);
      await store.setDailyReset('t-6', true);
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('panel mode (the MyGo popup window)', () => {
    const hidden = { width: 880, height: 520, expanded: false, pinned: false };

    it('starts as the drawer and never resizes the window on its own', async () => {
      const { store, bridge } = setup({ mode: 'panel' });
      expect(store.getState().ui.expanded).toBe(true);
      await store.init();
      await store.setSlotState('s-2', 'focus');
      await store.createSlot({ title: '新的一张' });
      expect(bridge.lastGeometry).toBeNull();
    });

    it('collapsing asks the host to hide the 880×520 window and keeps the drawer', async () => {
      const { store, bridge, cues } = setup({ mode: 'panel' });
      await store.init();
      store.setExpanded(false);
      expect(bridge.lastGeometry).toEqual(hidden);
      expect(store.getState().ui.expanded).toBe(true);
      expect(cues).toContain('settle');
    });

    it('sends one hide for Escape and the blur that follows it', async () => {
      const { store, bridge, clock } = setup({ mode: 'panel' });
      await store.init();
      const resize = vi.spyOn(bridge.dock, 'resize');
      expect(store.collapseIfUnpinned()).toBe(true);
      expect(store.collapseIfUnpinned()).toBe(true);
      expect(resize).toHaveBeenCalledTimes(1);
      clock.advance(600);
      store.collapseIfUnpinned();
      expect(resize).toHaveBeenCalledTimes(2);
    });

    it('stays up while pinned, and says so in the hide request once unpinned', async () => {
      const { store, bridge, clock } = setup({ mode: 'panel' });
      await store.init();
      await store.togglePin();
      expect(store.collapseIfUnpinned()).toBe(false);
      expect(bridge.lastGeometry).toBeNull();
      // The collapse button still hides a pinned panel.
      store.setExpanded(false);
      expect(bridge.lastGeometry).toEqual({ ...hidden, pinned: true });
      clock.advance(600);
      await store.togglePin();
      expect(store.collapseIfUnpinned()).toBe(true);
      expect(bridge.lastGeometry).toEqual(hidden);
    });

    it('leaves the view alone when the host toggles its window', async () => {
      const { store, bridge } = setup({ mode: 'panel' });
      await store.init();
      bridge.toggleDock(false);
      bridge.toggleDock();
      await flush();
      expect(store.getState().ui.expanded).toBe(true);
      expect(bridge.lastGeometry).toBeNull();
    });

    it('keeps the asks that open things: a new card, the composer, the search', async () => {
      const { store } = setup({ mode: 'panel' });
      await store.init();
      store.requestNewSlot();
      store.requestSearch();
      store.setExpanded(true, { highlightSlotId: 's-3' });
      expect(store.getState().ui).toMatchObject({ expanded: true, newSlotSignal: 1, searchSignal: 1, highlightSlotId: 's-3' });
    });
  });

  it('remembers UI choices in its preference storage', async () => {
    const data = new Map<string, string>();
    const prefs = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const first = setup();
    const { AppStore } = await import('./store');
    const store = new AppStore({ bridge: first.bridge, clock: first.clock, prefs });
    store.setThemeChoice('system');
    store.setNotesScope('focus');
    const again = new AppStore({ bridge: first.bridge, clock: first.clock, prefs });
    expect(again.getState().ui).toMatchObject({ followSystem: true, notesScope: 'focus' });
    expect(data.get('featherlog.ui.v2')).not.toContain('taskTab');
  });
});
