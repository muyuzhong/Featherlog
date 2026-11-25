import { describe, expect, it, vi } from 'vitest';
import { createBridge, findRuntime, GO_METHODS, MyGoBridge, type RuntimeLike } from './bridge';
import { LocalMockBridge } from './mock';

function fakeRuntime(reply: (method: string, args: unknown[]) => unknown = () => null) {
  const listeners = new Map<string, (p: unknown) => void>();
  const rt: RuntimeLike & { calls: Array<[string, unknown[]]>; emit(name: string, p: unknown): void } = {
    calls: [],
    call: vi.fn(async (method: string, ...args: unknown[]) => {
      rt.calls.push([method, args]);
      return reply(method, args);
    }),
    on: vi.fn((name: string, listener: (p: unknown) => void) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }),
    emit: (name, p) => listeners.get(name)?.(p),
  };
  return rt;
}

describe('findRuntime', () => {
  it('prefers __FEATHERLOG_MYGO__, then MyGo\'s window.mygo', () => {
    const a = fakeRuntime();
    const b = fakeRuntime();
    expect(findRuntime({ __FEATHERLOG_MYGO__: a, mygo: b })).toBe(a);
    expect(findRuntime({ mygo: b })).toBe(b);
    expect(findRuntime({ mygo: { call: 1 } })).toBeNull();
    expect(findRuntime({})).toBeNull();
  });

  it('createBridge uses the host when there is one, the mock otherwise', () => {
    expect(createBridge({ scope: { mygo: fakeRuntime() } }).kind).toBe('mygo');
    const mock = createBridge({ scope: {}, mock: { storage: null } });
    expect(mock).toBeInstanceOf(LocalMockBridge);
    (mock as LocalMockBridge).dispose();
    const forced = createBridge({ scope: { mygo: fakeRuntime() }, force: 'mock', mock: { storage: null } });
    expect(forced.kind).toBe('mock');
    (forced as LocalMockBridge).dispose();
  });
});

describe('MyGoBridge', () => {
  it('calls the Go methods by their bound names with one JSON input', async () => {
    const rt = fakeRuntime(() => []);
    const bridge = new MyGoBridge(rt);
    await bridge.workbench.list();
    await bridge.workbench.setState({ id: 's', state: 'running', remindInMinutes: 10 });
    await bridge.tasks.stepQuota({ id: 't', delta: -1 });
    await bridge.notes.list();
    await bridge.settings.update({ pinned: true });
    await bridge.dock.resize({ width: 880, height: 520, expanded: true });
    await bridge.dock.toggle();
    await bridge.dock.toggle({ expanded: false });
    expect(rt.calls).toEqual([
      [GO_METHODS.workbench.list, []],
      ['WorkbenchService.SetState', [{ id: 's', state: 'running', remindInMinutes: 10 }]],
      ['TaskService.StepQuota', [{ id: 't', delta: -1 }]],
      ['NoteService.List', [{}]],
      ['SettingsService.Update', [{ pinned: true }]],
      ['DockService.Resize', [{ width: 880, height: 520, expanded: true }]],
      ['DockService.Toggle', [{}]],
      ['DockService.Toggle', [{ expanded: false }]],
    ]);
  });

  it('reads Toggle\'s answer, and fills settings a backend from before barMode leaves out', async () => {
    const rt = fakeRuntime((method) => {
      if (method === 'DockService.Toggle') return { expanded: true };
      if (method === 'SettingsService.Get') return { theme: 'graphite', dayStartHour: 4, sound: true, volume: 5, pinned: false };
      if (method === 'SettingsService.Update') return { theme: 'stone', dayStartHour: 4, sound: true, volume: 5, pinned: false, barMode: 'weird', barX: null };
      return null;
    });
    const bridge = new MyGoBridge(rt);
    expect(await bridge.dock.toggle()).toEqual({ expanded: true });
    expect((await bridge.settings.get()).barMode).toBe('auto');
    const updated = await bridge.settings.update({ barX: null, barY: null });
    expect(updated).toMatchObject({ barMode: 'auto', barX: null });
    expect(rt.calls.at(-1)).toEqual(['SettingsService.Update', [{ barX: null, barY: null }]]);
  });

  it('treats a missing Toggle answer as closed', async () => {
    const bridge = new MyGoBridge(fakeRuntime(() => null));
    expect(await bridge.dock.toggle({ expanded: true })).toEqual({ expanded: false });
  });

  it('never sends undefined fields', async () => {
    const rt = fakeRuntime(() => ({ id: 's', title: 'x', state: 'focus', breadcrumb: '', stateChangedAt: 0, order: 0, createdAt: 0, updatedAt: 0 }));
    await new MyGoBridge(rt).workbench.create({ title: 'x', tag: undefined, state: 'focus' });
    expect(rt.calls[0]?.[1]).toEqual([{ title: 'x', state: 'focus' }]);
  });

  it('reads Go\'s nulls as absent fields and nil slices as empty lists', async () => {
    const rt = fakeRuntime((method) => {
      if (method === 'WorkbenchService.List') return null;
      if (method === 'TaskService.List') {
        return {
          periodKey: '2026-11-25',
          tasks: [{ id: 't', kind: 'side', title: 't', status: 'active', items: null, quota: null, dueToday: false, overdue: false, order: 0, createdAt: 0 }],
        };
      }
      return null;
    });
    const bridge = new MyGoBridge(rt);
    expect(await bridge.workbench.list()).toEqual([]);
    const { tasks } = await bridge.tasks.list();
    expect(tasks[0]?.items).toEqual([]);
    expect(tasks[0]).not.toHaveProperty('quota');
  });

  it('subscribes to the backend events and normalises their payloads', () => {
    const rt = fakeRuntime();
    const bridge = new MyGoBridge(rt);
    const slots = vi.fn();
    const toggle = vi.fn();
    const off = bridge.on('workbench:changed', slots);
    bridge.on('dock:toggle', toggle);
    rt.emit('workbench:changed', [{ id: 's', title: 't', state: 'ready', breadcrumb: null, remindAt: null, stateChangedAt: 0, order: 0, createdAt: 0, updatedAt: 0 }]);
    rt.emit('dock:toggle', null);
    expect(slots.mock.calls[0]?.[0]?.[0]).toEqual({ id: 's', title: 't', state: 'ready', breadcrumb: '', stateChangedAt: 0, order: 0, createdAt: 0, updatedAt: 0 });
    expect(toggle).toHaveBeenCalledWith({});
    off();
    expect(rt.on).toHaveBeenCalledWith('workbench:changed', expect.any(Function));
  });
});
