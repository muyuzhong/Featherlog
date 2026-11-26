import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { flush, MIN, renderApp } from '../test/fixtures';

const trayChips = () => within(screen.getByRole('list', { name: '并发工作槽' })).getAllByRole('listitem');
const card = (n: number) => screen.getByRole('article', { name: new RegExp(`^${n}\\. `) });
const rowOf = (title: string, list = '待办列表') => {
  const tasks = screen.getByRole('list', { name: list });
  const li = within(tasks).getByDisplayValue(title).closest('li');
  if (!li) throw new Error(`no row for ${title}`);
  return li;
};
const values = (els: HTMLElement[]) => els.map((el) => (el as HTMLTextAreaElement).value);

describe('drum bar (browser preview, collapsed)', () => {
  const drum = () => document.querySelector('.drum') as HTMLElement;
  const places = () => trayChips().map((c) => c.dataset.place);
  const auxClick = (el: Element) => fireEvent(el, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));

  it('stands the focus in front, flanked by neighbours curling back; states by surface and type', async () => {
    await renderApp();
    const chips = trayChips();
    expect(chips.map((c) => c.dataset.state)).toEqual(['focus', 'running', 'ready']);
    expect(places()).toEqual(['front', 'right', 'left']);
    expect(within(chips[0]!).getByRole('button', { pressed: true }).getAttribute('aria-label')).toBe('1. 底部卡槽的展开动画，专注中');
    expect(chips[0]!.querySelector('.focus-bar')).not.toBeNull();
    expect(chips[0]!.style.transform).toContain('rotateY(0deg)');
    expect(chips[1]!.style.transform).toBe('translateX(78.801px) translateZ(-26px) rotateY(52deg) scale(0.84)');
    expect(chips[2]!.style.transform).toContain('rotateY(-52deg)');
    expect(within(chips[1]!).getByText('14m').className).toContain('tnum');
    expect(within(chips[2]!).getByText('待看').className).toBe('ready-tag');
    expect(screen.getByRole('button', { name: '待办：完成 1，共 8' }).textContent).toBe('1/8');
    expect(document.querySelector('.drum-hidden-ready')).toBeNull();
  });

  it('turns with the wheel, focusing what comes to the front, and wraps N-1 → 0 without rewinding', async () => {
    const { store, clock } = await renderApp();
    const wheel = (deltaY: number) => {
      fireEvent.wheel(drum(), { deltaY });
      act(() => clock.advance(100));
    };
    wheel(120);
    await flush();
    expect(store.getState().slots[1]?.state).toBe('focus');
    expect(places()).toEqual(['left', 'front', 'right']);
    wheel(120);
    await flush();
    expect(drum().dataset.target).toBe('2');
    wheel(120);
    await flush();
    // Slot 0 again, one step further on: target 3, not a rewind to 0.
    expect(drum().dataset.target).toBe('3');
    expect(store.getState().slots[0]?.state).toBe('focus');
    expect(places()).toEqual(['front', 'right', 'left']);
    wheel(-120);
    await flush();
    expect(drum().dataset.target).toBe('2');
    expect(store.getState().slots[2]?.state).toBe('focus');
  });

  it('takes one notch per 75ms, however fast the wheel spins', async () => {
    const { store } = await renderApp();
    fireEvent.wheel(drum(), { deltaY: 120 });
    fireEvent.wheel(drum(), { deltaY: 120 });
    fireEvent.wheel(drum(), { deltaY: 120 });
    await flush();
    expect(drum().dataset.target).toBe('1');
    expect(store.getState().slots.map((s) => s.state)).toEqual(['running', 'focus', 'ready']);
  });

  it('a click on a curled neighbour turns it to the front and focuses it', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    await user.click(within(trayChips()[2]!).getByRole('button'));
    await flush();
    expect(drum().dataset.target).toBe('-1');
    expect(trayChips()[2]!.dataset.place).toBe('front');
    expect(store.getState().slots.map((s) => s.state)).toEqual(['running', 'running', 'focus']);
  });

  it('a click on the focused front card opens the workbench', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    await user.click(within(trayChips()[0]!).getByRole('button'));
    expect(store.getState().ui.expanded).toBe(true);
  });

  it('a middle-click flips ready and running, and the drum stays put', async () => {
    const { store } = await renderApp();
    auxClick(within(trayChips()[2]!).getByRole('button'));
    await flush();
    expect(store.getState().slots[2]?.state).toBe('running');
    auxClick(within(trayChips()[0]!).getByRole('button'));
    await flush();
    expect(store.getState().slots[0]?.state).toBe('ready');
    expect(drum().dataset.target).toBe('0');
    expect(trayChips()[0]!.dataset.place).toBe('front');
  });

  it('with two slots, shows the one neighbour on the right', async () => {
    const { store } = await renderApp();
    await act(() => store.completeSlot('s-3'));
    await flush();
    expect(places()).toEqual(['front', 'right']);
  });

  it('with four or more, says how many ready cards wait behind, and turns to the first', async () => {
    const { store } = await renderApp();
    await act(async () => {
      await store.createSlot({ title: '第四张', state: 'running' });
      await store.createSlot({ title: '第五张', state: 'running' });
    });
    await flush();
    expect(trayChips().map((c) => c.dataset.place)).toEqual(['front', 'right', 'back', 'back', 'left']);
    const hint = screen.getByRole('button', { name: '背面还有 1 张待看' });
    expect(hint.textContent).toBe('待看 1');
    const user = userEvent.setup();
    await user.click(hint);
    await flush();
    expect(store.getState().slots.find((s) => s.id === 's-3')?.state).toBe('focus');
    expect(trayChips()[2]!.dataset.place).toBe('front');
    expect(screen.queryByRole('button', { name: /背面还有/ })).toBeNull();
  });

  it('an empty drum offers a new slot', async () => {
    const { store } = await renderApp({ seed: false });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '手上没有并发 · Alt+N 开一张' }));
    expect(store.getState().ui).toMatchObject({ expanded: true, newSlotSignal: 1 });
  });
});

describe('standalone bar window (?mode=bar)', () => {
  it('is only the drum bar, edge to edge on its own ground, with a drag grip', async () => {
    const { container } = await renderApp({ mode: 'bar' });
    expect(document.documentElement.dataset.mode).toBe('bar');
    const stage = container.querySelector('.stage') as HTMLElement;
    expect(stage.dataset.mode).toBe('bar');
    expect(container.querySelector('.tray')?.getAttribute('data-variant')).toBe('bar');
    expect(container.querySelector('.tray-handle')).not.toBeNull();
    expect(trayChips()).toHaveLength(3);
    expect(screen.queryByRole('combobox', { name: '搜索槽位、任务或命令' })).toBeNull();
    expect(container.querySelector('.preview-bar')).toBeNull();
  });

  it('opens and closes the host\'s workbench with DockService.Toggle, never by resizing itself', async () => {
    const { bridge, store } = await renderApp({ mode: 'bar' });
    const user = userEvent.setup();
    const toggle = vi.spyOn(bridge.dock, 'toggle');
    await user.click(within(trayChips()[0]!).getByRole('button'));
    await flush();
    expect(toggle).toHaveBeenLastCalledWith(undefined);
    const arrow = screen.getByRole('button', { name: '收起工作台' });
    expect(arrow.getAttribute('aria-expanded')).toBe('true');
    await user.click(arrow);
    await flush();
    expect(screen.getByRole('button', { name: '展开工作台' }).getAttribute('aria-expanded')).toBe('false');
    await user.click(screen.getByRole('button', { name: /^待办：/ }));
    await user.click(screen.getByRole('button', { name: '新并发槽' }));
    await flush();
    expect(toggle.mock.calls.slice(2)).toEqual([[{ expanded: true }], [{ expanded: true }]]);
    expect(bridge.lastGeometry).toBeNull();
    expect(store.getState().ui.expanded).toBe(false);
    expect(screen.queryByRole('combobox', { name: '搜索槽位、任务或命令' })).toBeNull();
  });

  it('follows the host when the workbench opens or hides elsewhere', async () => {
    const { bridge } = await renderApp({ mode: 'bar' });
    bridge.toggleDock(true);
    await flush();
    expect(screen.getByRole('button', { name: '收起工作台' })).toBeTruthy();
    bridge.toggleDock(false);
    await flush();
    expect(screen.getByRole('button', { name: '展开工作台' })).toBeTruthy();
  });

  it('stays as it is on blur and on Escape', async () => {
    const { bridge, store } = await renderApp({ mode: 'bar', collapseOnBlur: true });
    const toggle = vi.spyOn(bridge.dock, 'toggle');
    const resize = vi.spyOn(bridge.dock, 'resize');
    fireEvent.blur(window);
    fireEvent.keyDown(window, { key: 'Escape' });
    await flush();
    expect(toggle).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
    expect(trayChips()).toHaveLength(3);
    expect(store.getState().ui.panelOpen).toBe(false);
  });

  it('still turns with the wheel and focuses', async () => {
    const { store } = await renderApp({ mode: 'bar' });
    fireEvent.wheel(document.querySelector('.drum')!, { deltaY: -120 });
    await flush();
    expect(store.getState().slots[2]?.state).toBe('focus');
  });
});

describe('header', () => {
  it('keeps only the name, the search and three icon buttons: settings, pin, collapse', async () => {
    const { container } = await renderApp({ expanded: true });
    const head = container.querySelector('.head') as HTMLElement;
    expect(within(head).getByText('羽记').className).toBe('wordmark');
    expect(container.querySelector('.head-date, .head-sub')).toBeNull();
    expect(head.textContent).not.toMatch(/换日|月\d+日|周[一二三四五六日]/);
    const right = head.querySelector('.head-right') as HTMLElement;
    expect(within(right).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['设置', '钉住面板', '收起']);
    expect(within(head).queryByRole('radiogroup')).toBeNull();
    expect(head.textContent).not.toMatch(/常驻条|自动|托盘/);
  });
});

describe('settings popover', () => {
  const gear = () => screen.getByRole('button', { name: '设置' });
  const openSettings = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(gear());
    return screen.getByRole('dialog', { name: '设置' });
  };

  it('opens under the gear with language, theme, sound and day rollover, and no volume slider', async () => {
    await renderApp({ expanded: true });
    const user = userEvent.setup();
    expect(gear().getAttribute('aria-expanded')).toBe('false');
    const pop = await openSettings(user);
    expect(gear().getAttribute('aria-expanded')).toBe('true');
    expect(gear().closest('.settings-anchor')?.contains(pop)).toBe(true);
    expect(within(pop).getAllByRole('radiogroup').map((g) => g.getAttribute('aria-label'))).toEqual(['语言', '外观']);
    expect(within(pop).getAllByRole('radio').map((r) => r.textContent)).toEqual(['简体中文', 'English', '纸石', '石墨', '跟随系统']);
    expect(within(pop).getByRole('switch', { name: '提示音' }).getAttribute('aria-checked')).toBe('true');
    expect(within(pop).getByRole('spinbutton', { name: '换日时间' }).textContent).toBe('04:00');
    expect(within(pop).queryByRole('slider')).toBeNull();
    expect(pop.querySelector('input[type="range"]')).toBeNull();
    expect(pop.textContent).not.toMatch(/音量|volume/i);
    // The bar was never dragged: nothing to reset.
    expect(within(pop).queryByRole('button', { name: '重置滚筒位置' })).toBeNull();
  });

  it('closes on Esc without hiding the workbench, and on a click outside', async () => {
    const { store } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    await openSettings(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(store.getState().ui.expanded).toBe(true);
    expect(gear().getAttribute('aria-expanded')).toBe('false');

    await openSettings(user);
    await user.click(screen.getByRole('heading', { name: '待办' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(store.getState().ui.expanded).toBe(true);

    // A second press on the gear closes it too.
    await openSettings(user);
    await user.click(gear());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a click inside keeps it open', async () => {
    await renderApp({ expanded: true });
    const user = userEvent.setup();
    const pop = await openSettings(user);
    await user.click(within(pop).getByRole('switch', { name: '提示音' }));
    expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy();
  });

  it('switches 纸石, 石墨 and 跟随系统', async () => {
    const { bridge } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    const pop = await openSettings(user);
    const theme = within(pop).getByRole('radiogroup', { name: '外观' });
    expect(document.documentElement.dataset.theme).toBe('stone');
    await user.click(within(theme).getByRole('radio', { name: '石墨' }));
    await flush();
    expect(document.documentElement.dataset.theme).toBe('graphite');
    expect((await bridge.settings.get()).theme).toBe('graphite');
    await user.click(within(theme).getByRole('radio', { name: '跟随系统' }));
    await flush();
    expect(within(theme).getByRole('radio', { name: '跟随系统' }).getAttribute('aria-checked')).toBe('true');
    // The test desktop is light.
    expect(document.documentElement.dataset.theme).toBe('stone');
  });

  it('turns the sound off and on with one switch', async () => {
    const { bridge } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    const pop = await openSettings(user);
    const sound = within(pop).getByRole('switch', { name: '提示音' });
    expect(sound.textContent).toBe('开启');
    await user.click(sound);
    await flush();
    expect(sound.getAttribute('aria-checked')).toBe('false');
    expect(sound.textContent).toBe('静音');
    expect((await bridge.settings.get()).sound).toBe(false);
    await user.click(sound);
    await flush();
    expect((await bridge.settings.get()).sound).toBe(true);
  });

  it('steps the day rollover by the hour, wrapping round midnight, by button or arrow key', async () => {
    const { bridge } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    const pop = await openSettings(user);
    const hour = within(pop).getByRole('spinbutton', { name: '换日时间' });
    await user.click(within(pop).getByRole('button', { name: '推后一小时' }));
    await flush();
    expect(hour.textContent).toBe('05:00');
    expect(hour.getAttribute('aria-valuenow')).toBe('5');
    expect((await bridge.settings.get()).dayStartHour).toBe(5);
    for (let i = 0; i < 6; i++) await user.click(within(pop).getByRole('button', { name: '提前一小时' }));
    await flush();
    expect(hour.textContent).toBe('23:00');
    expect((await bridge.settings.get()).dayStartHour).toBe(23);
    hour.focus();
    await user.keyboard('{ArrowUp}');
    await flush();
    expect(hour.textContent).toBe('00:00');
    await user.keyboard('{End}');
    await flush();
    expect((await bridge.settings.get()).dayStartHour).toBe(23);
    // Arrow keys on the hour never reach the window: the popover stays.
    expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy();
  });

  it('offers 重置滚筒位置 only once the bar was dragged, and resets it with nulls', async () => {
    const { bridge } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    const update = vi.spyOn(bridge.settings, 'update');
    await act(() => bridge.settings.update({ barX: 300, barY: 1040 }));
    await flush();
    const pop = await openSettings(user);
    await user.click(within(pop).getByRole('button', { name: '重置滚筒位置' }));
    await flush();
    expect(update).toHaveBeenLastCalledWith({ barX: null, barY: null });
    expect((await bridge.settings.get())).not.toHaveProperty('barX');
    expect(within(pop).queryByRole('button', { name: '重置滚筒位置' })).toBeNull();
  });

  it('Ctrl+K resets the bar position only when there is one to forget, and offers no bar mode', async () => {
    const { bridge } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    const update = vi.spyOn(bridge.settings, 'update');
    const box = screen.getByRole('combobox', { name: '搜索槽位、任务或命令' });
    await user.click(box);
    await user.type(box, '滚筒');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['命令在随笔里搜「滚筒」']);
    await user.clear(box);
    await user.type(box, '常驻条');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['命令在随笔里搜「常驻条」']);
    await user.keyboard('{Escape}');
    await act(() => bridge.settings.update({ barX: 12 }));
    await flush();
    await user.click(box);
    await user.type(box, '重置滚筒');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['命令在随笔里搜「重置滚筒」', '命令重置滚筒位置']);
    await user.keyboard('{ArrowDown}{Enter}');
    await flush();
    expect(update).toHaveBeenLastCalledWith({ barX: null, barY: null });
  });
});

describe('中文 / English', () => {
  const switchTo = async (user: ReturnType<typeof userEvent.setup>, from: '设置' | 'Settings', name: '简体中文' | 'English') => {
    await user.click(screen.getByRole('button', { name: from }));
    const pop = screen.getByRole('dialog', { name: from });
    await user.click(within(pop).getByRole('radio', { name }));
    await flush();
  };

  it('switches the whole workbench at once, and back', async () => {
    const { bridge, container } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    expect(document.documentElement.lang).toBe('zh-CN');
    await switchTo(user, '设置', 'English');
    expect((await bridge.settings.get()).language).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(document.title).toBe('Featherlog');

    // The popover itself, still open, has turned.
    const pop = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(pop).getAllByRole('radiogroup').map((g) => g.getAttribute('aria-label'))).toEqual(['Language', 'Theme']);
    expect(within(pop).getAllByRole('radio').map((r) => r.textContent)).toEqual(['简体中文', 'English', 'Stone', 'Graphite', 'System']);
    expect(within(pop).getByRole('switch', { name: 'Sound' }).textContent).toBe('On');
    expect(within(pop).getByRole('spinbutton', { name: 'Day rollover' })).toBeTruthy();
    await user.keyboard('{Escape}');

    // Header and search.
    expect(container.querySelector('.wordmark')?.textContent).toBe('Featherlog');
    expect(screen.getByRole('combobox', { name: 'Search slots, todos or commands' }).getAttribute('placeholder')).toBe('Jump to a slot, todo or command…');
    expect(screen.getByRole('button', { name: 'Pin panel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeTruthy();

    // Now deck.
    expect(screen.getByRole('region', { name: 'In flight now' }).textContent).toContain('3 cards');
    expect(within(card(1)).getByText('In focus')).toBeTruthy();
    expect(within(card(1)).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Focus', 'Running', 'Ready']);
    expect(within(card(2)).getAllByRole('button', { name: /^Remind me to check back in \d+ min$/ })).toHaveLength(3);
    expect(within(card(3)).getByText('READY').className).toBe('ready-tag');
    expect(within(card(1)).getByRole('button', { name: 'Wrap up' })).toBeTruthy();

    // Todos: tally, quick add, deadline, quota and the details.
    const todos = screen.getByRole('region', { name: 'Todos' });
    expect(within(todos).getByRole('heading', { name: 'Todos' })).toBeTruthy();
    expect(within(todos).getByLabelText('1 of 8 done').textContent).toBe('1/8');
    expect(within(todos).getByRole('textbox', { name: 'New todo' }).getAttribute('placeholder')).toBe('New todo, Enter to add (end with ×5 for a count)');
    expect(within(rowOf('整理 seamline 的 flaky 用例清单', 'Todo list')).getByText('1 day overdue')).toBeTruthy();
    expect(within(rowOf('压测 barhttp 长轮询', 'Todo list')).getByRole('group', { name: 'Count 2/6' })).toBeTruthy();
    const row = rowOf('v2 前端：面板模式联调', 'Todo list');
    expect(within(row).getByText('Steps 1/4')).toBeTruthy();
    await user.click(within(row).getByRole('button', { name: 'Show details' }));
    expect(within(row).getByRole('switch', { name: 'Daily reset' })).toBeTruthy();
    expect(within(row).getByRole('textbox', { name: 'Add step' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Delete todo' })).toBeTruthy();
    expect(within(rowOf('看一眼夜间构建', 'Todo list')).getByRole('button', { name: 'Show details' })).toBeTruthy();

    // Notes.
    const notes = screen.getByRole('region', { name: 'Notes' });
    expect(within(notes).getAllByRole('radio').map((r) => r.textContent)).toEqual(['All notes', 'Focus notes']);
    expect(within(notes).getByRole('textbox', { name: 'Search notes' })).toBeTruthy();
    expect(within(notes).getByRole('textbox', { name: 'New note' }).getAttribute('placeholder')).toBe('Jot something down…');
    expect(within(notes).getAllByRole('button', { name: 'Delete this note' }).length).toBeGreaterThan(0);

    // No Chinese left in the chrome: what is still Chinese is the user's own text.
    const chrome = [...container.querySelectorAll('button, [aria-label], [placeholder], .section-title, .deck-hint, .empty, .meta-text, .task-meta')]
      .filter((el) => !el.closest('.inline, .note-body') && !(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement))
      .flatMap((el) => [el.getAttribute('aria-label') ?? '', el.getAttribute('placeholder') ?? '', el.matches('button, .section-title, .deck-hint, .empty') ? (el.textContent ?? '') : ''])
      .filter((text) => /[\u4e00-\u9fff]/.test(text));
    const userText = ['v2 前端', '压测', 'clipnest', 'seamline', 'frontend README', '夜间构建', '待审 PR', 'MyGo', '底部卡槽', 'Claude', 'Codex', '收起态', '面板铺满', 'Esc / 失焦', 'Go 宿主'];
    expect(chrome.filter((text) => !userText.some((u) => text.includes(u)))).toEqual([]);

    await switchTo(user, 'Settings', '简体中文');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(container.querySelector('.wordmark')?.textContent).toBe('羽记');
    expect(screen.getByRole('region', { name: '待办' })).toBeTruthy();
    expect(card(3).querySelector('.ready-tag')?.textContent).toBe('待看');
  });

  it('Ctrl+K switches the language from either side, and words its commands in it', async () => {
    const { bridge } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    let box = screen.getByRole('combobox', { name: '搜索槽位、任务或命令' });
    await user.click(box);
    await user.type(box, 'english');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['命令在随笔里搜「english」', '命令切换语言为 English']);
    await user.keyboard('{ArrowDown}{Enter}');
    await flush();
    expect((await bridge.settings.get()).language).toBe('en');

    box = screen.getByRole('combobox', { name: 'Search slots, todos or commands' });
    await user.click(box);
    await user.type(box, 'PR');
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Todo过一遍待审 PR');
    expect(options[0]).toBe('SlotClaude 在跑 e2e 回归Alt+2');
    await user.clear(box);
    await user.type(box, '语言');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['CommandSearch notes for “语言”', 'CommandSwitch language to 简体中文']);
    await user.keyboard('{ArrowDown}{Enter}');
    await flush();
    expect((await bridge.settings.get()).language).toBe('zh');
  });

  it('the drum bar speaks English too, with a READY label', async () => {
    const { store } = await renderApp({ mode: 'bar' });
    await act(() => store.setLanguage('en'));
    await flush();
    expect(screen.getByRole('list', { name: 'Work slots' })).toBeTruthy();
    const chips = within(screen.getByRole('list', { name: 'Work slots' })).getAllByRole('listitem');
    expect(within(chips[0]!).getByRole('button').getAttribute('aria-label')).toBe('1. 底部卡槽的展开动画, in focus');
    expect(within(chips[2]!).getByText('READY').className).toBe('ready-tag');
    expect(screen.getByRole('button', { name: 'Todos: 1 of 8 done' }).textContent).toBe('1/8');
    expect(screen.getByRole('button', { name: 'Open the workbench' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New slot' })).toBeTruthy();
    expect(document.querySelector('.tray-handle')?.getAttribute('title')).toBe('Drag the bar');
  });

  it('words a failure in the current language, and re-words it on a switch', async () => {
    const { bridge, store } = await renderApp({ expanded: true });
    vi.spyOn(bridge.workbench, 'setState').mockRejectedValueOnce(new Error('workbench/busy'));
    await act(() => store.setSlotState('s-2', 'focus'));
    expect(screen.getByRole('status').textContent).toBe('切换状态失败：workbench/busy');
    await act(() => store.setLanguage('en'));
    await flush();
    expect(screen.getByRole('status').textContent).toBe('Switching state failed: workbench/busy');
  });
});

describe('now deck', () => {
  it('switches a card between 专注, 后台 and 待看, keeping one focus', async () => {
    await renderApp({ expanded: true });
    const user = userEvent.setup();
    await user.click(within(card(1)).getByRole('radio', { name: '后台' }));
    await flush();
    expect(card(1).dataset.state).toBe('running');
    expect(within(card(1)).getByText('0s')).toBeTruthy();
    expect(within(card(1)).getAllByRole('button', { name: /分钟后提醒回看/ })).toHaveLength(3);

    await user.click(within(card(1)).getByRole('radio', { name: '待看' }));
    await flush();
    expect(card(1).dataset.state).toBe('ready');
    expect(card(1).querySelector('.ready-tag')?.textContent).toBe('待看');

    await user.click(within(card(3)).getByRole('radio', { name: '专注' }));
    await flush();
    expect(card(3).dataset.state).toBe('focus');
    expect(within(card(3)).getByText('专注中')).toBeTruthy();
    expect(screen.getAllByRole('article').filter((a) => a.dataset.state === 'focus')).toHaveLength(1);
  });

  it('edits the breadcrumb in place: Enter saves, Escape puts it back without collapsing', async () => {
    const { bridge, store } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    const crumb = within(card(2)).getByRole('textbox', { name: '断点备忘' }) as HTMLInputElement;
    await user.clear(crumb);
    await user.type(crumb, 'CI 绿了就合并{Enter}');
    await flush();
    expect((await bridge.workbench.list())[1]?.breadcrumb).toBe('CI 绿了就合并');
    expect(document.activeElement).not.toBe(crumb);

    await user.type(crumb, '——草稿');
    await user.keyboard('{Escape}');
    await flush();
    expect(crumb.value).toBe('CI 绿了就合并');
    expect((await bridge.workbench.list())[1]?.breadcrumb).toBe('CI 绿了就合并');
    expect(store.getState().ui.expanded).toBe(true);
  });

  it('does not save while an input method is composing', async () => {
    const { bridge } = await renderApp({ expanded: true });
    const crumb = within(card(1)).getByRole('textbox', { name: '断点备忘' }) as HTMLInputElement;
    crumb.focus();
    fireEvent.change(crumb, { target: { value: 'xia yi bu' } });
    fireEvent.keyDown(crumb, { key: 'Enter', keyCode: 229 });
    await flush();
    expect(document.activeElement).toBe(crumb);
    expect((await bridge.workbench.list())[0]?.breadcrumb).toBe('收起宽度算法定了，接着调焦点板的弹簧');
  });

  it('+10m sets a reminder whose hairline counts down, and the card turns 待看 when due', async () => {
    const { clock } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    await user.click(within(card(1)).getByRole('radio', { name: '后台' }));
    await flush();
    await user.click(within(card(1)).getByRole('button', { name: '10 分钟后提醒回看' }));
    await flush();
    const line = within(card(1)).getByRole('progressbar', { name: '回看倒计时' });
    expect(line.getAttribute('aria-valuenow')).toBe('0');
    act(() => clock.advance(5 * MIN));
    expect(within(card(1)).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    act(() => clock.advance(5 * MIN + 1000));
    await flush();
    expect(card(1).dataset.state).toBe('ready');
    expect(within(card(1)).queryByRole('progressbar')).toBeNull();
  });

  it('完成下台 on a slot with a task asks whether the task is done too', async () => {
    const { bridge, store } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    await user.click(within(card(1)).getByRole('button', { name: '完成下台' }));
    await user.click(within(card(1)).getByRole('button', { name: '连任务一起完成' }));
    await flush();
    expect(store.getState().slots.map((s) => s.id)).toEqual(['s-2', 's-3']);
    expect((await bridge.tasks.list()).tasks.find((t) => t.id === 't-1')?.status).toBe('completed');
  });

  it('Alt+N opens a new card that goes into focus on Enter', async () => {
    const { store } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', altKey: true });
    const title = await screen.findByRole('textbox', { name: '新卡标题' });
    await waitFor(() => expect(document.activeElement).toBe(title));
    await user.type(title, '复盘 PR #42{Enter}');
    await flush();
    expect(store.getState().slots.at(-1)).toMatchObject({ title: '复盘 PR #42', state: 'focus' });
    expect(store.getState().slots.filter((s) => s.state === 'focus')).toHaveLength(1);
  });

  it('scrolls the overflowing deck row horizontally on vertical wheel and keeps focused cards in view', async () => {
    const { store, container } = await renderApp({ expanded: true });
    await act(async () => {
      await store.createSlot({ title: '毕业设计', state: 'running' });
    });
    await flush();

    // Linked task titles live in an inner span so ellipsis works inside inline-flex.
    expect(card(1).querySelector('.card-task > span')?.textContent).toBe('v2 前端：面板模式联调');

    const row = container.querySelector('.deck-row') as HTMLElement;
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 852 });
    Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 1004 });
    row.scrollLeft = 0;

    const wheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    row.dispatchEvent(wheel);
    expect(row.scrollLeft).toBe(120);
    expect(wheel.defaultPrevented).toBe(true);

    // Focusing the 4th card brings it into view.
    const card4 = card(4);
    const scrollIntoView = vi.fn();
    card4.scrollIntoView = scrollIntoView;
    fireEvent.keyDown(window, { key: '4', code: 'Digit4', altKey: true });
    await flush();
    expect(card(4).dataset.state).toBe('focus');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  });
});

describe('todos', () => {
  it('is one flat list titled 待办, with no 主线 / 支线 / 日常 anywhere', async () => {
    const { container } = await renderApp({ expanded: true });
    const panel = screen.getByRole('region', { name: '待办' });
    expect(within(panel).getByRole('heading', { name: '待办' })).toBeTruthy();
    expect(within(panel).queryAllByRole('radio')).toEqual([]);
    expect(within(panel).queryByRole('radiogroup')).toBeNull();
    expect(panel.textContent).not.toMatch(/主线|支线|日常|今日/);
    expect(container.querySelector('.kind-pick, .kind-chip')).toBeNull();
    // Open todos in the order they were added, the daily ones among them.
    const titles = values(within(screen.getByRole('list', { name: '待办列表' })).getAllByRole('textbox', { name: '待办标题' }));
    expect(titles).toEqual([
      'v2 前端：面板模式联调',
      '压测 barhttp 长轮询',
      '给 clipnest 提 Linux 托盘的 issue',
      '整理 seamline 的 flaky 用例清单',
      '补 frontend README 的对接说明',
      '看一眼夜间构建',
      '过一遍待审 PR',
    ]);
    expect(within(panel).getByLabelText('完成 1，共 8').textContent).toBe('1/8');
  });

  it('folds finished todos under 已完成 and counts them', async () => {
    await renderApp({ expanded: true });
    const user = userEvent.setup();
    expect(screen.queryByDisplayValue('升级 MyGo 到 0.8.3')).toBeNull();
    await user.click(within(rowOf('给 clipnest 提 Linux 托盘的 issue')).getByRole('checkbox'));
    await flush();
    const fold = screen.getByRole('button', { name: /已完成/ });
    expect(fold.textContent).toContain('2');
    await user.click(fold);
    expect(screen.getByDisplayValue('升级 MyGo 到 0.8.3')).toBeTruthy();
    expect(screen.getByLabelText('完成 2，共 8').textContent).toBe('2/8');
  });

  it('creates a plain todo in one line, reading ×N as its count', async () => {
    const { bridge } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: '新建待办' });
    expect(input.getAttribute('placeholder')).toBe('新建待办，回车即建（末尾写 ×5 设次数）');
    await user.type(input, '复查 KWin 定位 ×3{Enter}');
    await flush();
    const created = (await bridge.tasks.list()).tasks.find((t) => t.title === '复查 KWin 定位');
    expect(created).toMatchObject({ kind: 'side', quota: { current: 0, target: 3 }, scheduledFor: '2026-11-25', dueToday: true });
    expect(created).not.toHaveProperty('recurrence');
    expect(rowOf('复查 KWin 定位')).toBeTruthy();
    expect(screen.getByLabelText('完成 1，共 9')).toBeTruthy();
  });

  it('ticks sub-steps in any order', async () => {
    const { bridge } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    const row = rowOf('v2 前端：面板模式联调');
    await user.click(within(row).getByRole('button', { name: '展开详情' }));
    await user.click(within(row).getByRole('checkbox', { name: '和 Go 宿主联调 Resize' }));
    await user.click(within(row).getByRole('checkbox', { name: 'Esc / 失焦隐藏弹窗' }));
    await flush();
    const t1 = (await bridge.tasks.list()).tasks.find((t) => t.id === 't-1');
    expect(t1?.items.map((i) => i.done)).toEqual([true, false, true, true]);
    expect(within(row).getByRole('checkbox', { name: '面板铺满不透明窗口' }).getAttribute('aria-checked')).toBe('false');
    expect(within(row).getByText('子项 3/4')).toBeTruthy();
  });

  it('adds a sub-step and removes one', async () => {
    const { bridge } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    const row = rowOf('v2 前端：面板模式联调');
    await user.click(within(row).getByRole('button', { name: '展开详情' }));
    await user.type(within(row).getByRole('textbox', { name: '添加子项' }), '写 README{Enter}');
    await flush();
    await user.click(within(row).getByRole('button', { name: '删除子项「收起态交给 Plasmoid」' }));
    await flush();
    const t1 = (await bridge.tasks.list()).tasks.find((t) => t.id === 't-1');
    expect(t1?.items.map((i) => i.text)).toEqual(['面板铺满不透明窗口', 'Esc / 失焦隐藏弹窗', '和 Go 宿主联调 Resize', '写 README']);
  });

  it('counts up with a click, down with a right-click, and completes at the target', async () => {
    const { bridge } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    const row = rowOf('压测 barhttp 长轮询');
    const count = within(row).getByRole('button', { name: '次数加一（右键减一）' });
    await user.click(count);
    await flush();
    expect(within(row).getByRole('group', { name: '次数 3/6' })).toBeTruthy();
    fireEvent.contextMenu(count);
    await flush();
    expect(within(row).getByRole('group', { name: '次数 2/6' })).toBeTruthy();
    for (let i = 0; i < 4; i++) {
      await user.click(count);
      await flush();
    }
    const t2 = (await bridge.tasks.list()).tasks.find((t) => t.id === 't-2');
    expect(t2).toMatchObject({ status: 'completed', quota: { current: 6, target: 6 } });
  });

  it('每日重置 is a switch in the details, the only place the difference shows', async () => {
    const { bridge } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    const row = rowOf('补 frontend README 的对接说明');
    expect(within(row).queryByRole('switch')).toBeNull();
    await user.click(within(row).getByRole('button', { name: '展开详情' }));
    const toggle = within(row).getByRole('switch', { name: '每日重置' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    await flush();
    const daily = (await bridge.tasks.list()).tasks.find((t) => t.id === 't-5');
    expect(daily).toMatchObject({ id: 't-5', kind: 'daily', recurrence: { freq: 'daily' } });
    // Still the same row with details open; collapsing shows zero tier/daily labels on the row itself.
    expect(within(row).getByRole('switch', { name: '每日重置' }).getAttribute('aria-checked')).toBe('true');
    expect(within(row).getByText('每天 4:00 清零')).toBeTruthy();
    await user.click(within(row).getByRole('button', { name: '收起详情' }));
    expect(rowOf('补 frontend README 的对接说明').textContent).not.toMatch(/日常|每日/);
  });

  it('上台 puts a todo on the deck, in focus', async () => {
    await renderApp({ expanded: true });
    const user = userEvent.setup();
    const row = rowOf('给 clipnest 提 Linux 托盘的 issue');
    await user.click(within(row).getByRole('button', { name: /上台/ }));
    await flush();
    const promoted = await screen.findByRole('article', { name: /给 clipnest/ });
    expect(promoted.dataset.state).toBe('focus');
    expect(within(rowOf('给 clipnest 提 Linux 托盘的 issue')).getByText('在台上')).toBeTruthy();
  });

  it('Ctrl+K finds todos without any kind label', async () => {
    await renderApp({ expanded: true });
    const user = userEvent.setup();
    const box = screen.getByRole('combobox', { name: '搜索槽位、任务或命令' });
    await user.click(box);
    await user.type(box, 'PR');
    const options = screen.getAllByRole('option');
    const todo = options.find((o) => o.textContent?.includes('过一遍待审 PR'));
    expect(todo?.textContent).toBe('待办过一遍待审 PR');
    expect(screen.getByRole('listbox').textContent).not.toMatch(/主线|支线|日常/);
  });
});

describe('notes', () => {
  it('焦点手记 shows the focus task\'s notes, and Ctrl+Enter files a new one under it', async () => {
    const { bridge } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: '焦点手记' }));
    await flush();
    const list = screen.getByRole('list', { name: '随笔' });
    expect(values(within(list).getAllByRole('textbox', { name: '随笔内容' }))).toEqual([
      '面板是不透明的 880×520 弹窗：收起只是让宿主把窗口藏起来，视图一直停在工作台，下次点状态栏秒开。',
    ]);
    expect(screen.getByText('v2 前端：面板模式联调', { selector: 'strong' })).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: '新随笔' }), '接口按契约先写');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await flush();
    expect(values(within(list).getAllByRole('textbox', { name: '随笔内容' }))[0]).toBe('接口按契约先写');
    expect((await bridge.notes.list({ taskId: 't-1' })).map((n) => n.content)).toContain('接口按契约先写');
    expect((screen.getByRole('textbox', { name: '新随笔' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('全部随笔 searches by keyword', async () => {
    const { clock } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: '搜索随笔' }), '待看');
    act(() => clock.advance(200));
    await flush();
    const list = screen.getByRole('list', { name: '随笔' });
    expect(values(within(list).getAllByRole('textbox', { name: '随笔内容' }))).toEqual([
      'AI 跑测试的空档别去刷手机，回卡槽扫一眼哪张写着「待看」。',
    ]);
  });

  it('edits a note where it stands and saves after a pause', async () => {
    const { bridge, clock } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    const list = screen.getByRole('list', { name: '随笔' });
    const first = within(list).getAllByRole('textbox', { name: '随笔内容' })[0]!;
    await user.type(first, '（补一句）');
    act(() => clock.advance(800));
    await flush();
    expect((await bridge.notes.list()).find((n) => n.id === 'n-1')?.content).toMatch(/（补一句）$/);
  });

  it('deletes a note only on the second click', async () => {
    const { bridge } = await renderApp({ expanded: true });
    const user = userEvent.setup();
    const list = screen.getByRole('list', { name: '随笔' });
    const before = (await bridge.notes.list()).length;
    await user.click(within(list).getAllByRole('button', { name: '删除这条随笔' })[0]!);
    expect((await bridge.notes.list()).length).toBe(before);
    await user.click(within(list).getByRole('button', { name: '确认删除' }));
    await flush();
    expect((await bridge.notes.list()).length).toBe(before - 1);
  });
});

describe('panel mode (MyGo popup, or ?mode=panel)', () => {
  const hidden = { width: 880, height: 520, expanded: false, pinned: false };

  it('renders only the drawer, edge to edge, with no bottom bar', async () => {
    const { container } = await renderApp({ mode: 'panel' });
    expect(screen.getByRole('combobox', { name: '搜索槽位、任务或命令' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: '并发工作槽' })).toBeNull();
    expect(screen.queryByRole('button', { name: '展开工作台' })).toBeNull();
    const stage = container.querySelector('.stage') as HTMLElement;
    expect(stage.dataset.mode).toBe('panel');
    expect((container.querySelector('.drawer') as HTMLElement).style.height).toBe('100%');
    expect((container.querySelector('.shell') as HTMLElement).getAttribute('style')).toBeNull();
    expect(document.documentElement.dataset.mode).toBe('panel');
    expect(container.querySelector('.preview-bar')).toBeNull();
  });

  it('the collapse button hides the window through DockService.Resize and keeps the drawer', async () => {
    const { bridge, store } = await renderApp({ mode: 'panel' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '收起' }));
    expect(bridge.lastGeometry).toEqual(hidden);
    expect(store.getState().ui.expanded).toBe(true);
    expect(screen.getByRole('combobox', { name: '搜索槽位、任务或命令' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: '并发工作槽' })).toBeNull();
  });

  it('Escape hides it unless pinned', async () => {
    const { bridge, clock } = await renderApp({ mode: 'panel' });
    fireEvent.keyDown(window, { key: 'p', code: 'KeyP', ctrlKey: true });
    await flush();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(bridge.lastGeometry).toBeNull();
    fireEvent.keyDown(window, { key: 'p', code: 'KeyP', ctrlKey: true });
    await flush();
    act(() => clock.advance(600));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(bridge.lastGeometry).toEqual(hidden);
    expect(screen.getByRole('combobox', { name: '搜索槽位、任务或命令' })).toBeTruthy();
  });

  it('losing focus hides it in the host, and an edit in progress is still saved', async () => {
    const { bridge } = await renderApp({ mode: 'panel', collapseOnBlur: true });
    const user = userEvent.setup();
    const crumb = within(card(2)).getByRole('textbox', { name: '断点备忘' });
    await user.clear(crumb);
    await user.type(crumb, '回来先看 CI');
    crumb.blur();
    fireEvent.blur(window);
    await flush();
    expect(bridge.lastGeometry).toEqual(hidden);
    expect((await bridge.workbench.list())[1]?.breadcrumb).toBe('回来先看 CI');
  });

  it('a browser tab without ?mode=panel keeps the bar and drawer switching', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    expect(screen.getByRole('list', { name: '并发工作槽' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '展开工作台' }));
    await user.click(screen.getByRole('button', { name: '收起' }));
    expect(store.getState().ui.expanded).toBe(false);
    await waitFor(() => expect(screen.getByRole('list', { name: '并发工作槽' })).toBeTruthy());
  });
});

describe('keyboard and chrome', () => {
  it('Alt+2 focuses the second slot; Ctrl+P pins; Escape collapses only when unpinned', async () => {
    const { store } = await renderApp({ expanded: true });
    fireEvent.keyDown(window, { key: '™', code: 'Digit2', altKey: true });
    await flush();
    expect(store.getState().slots[1]?.state).toBe('focus');

    fireEvent.keyDown(window, { key: 'p', code: 'KeyP', ctrlKey: true });
    await flush();
    expect(store.getState().settings.pinned).toBe(true);
    expect(screen.getByRole('button', { name: '取消钉住' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(store.getState().ui.expanded).toBe(true);

    fireEvent.keyDown(window, { key: 'p', code: 'KeyP', ctrlKey: true });
    await flush();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(store.getState().ui.expanded).toBe(false);
  });

  it('Ctrl+K opens the drawer with the search focused, and Enter jumps to a slot', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    const box = await screen.findByRole('combobox', { name: '搜索槽位、任务或命令' });
    await waitFor(() => expect(document.activeElement).toBe(box));
    await user.type(box, 'codex');
    expect(screen.getByRole('option', { name: /Codex 改完原子存储/ })).toBeTruthy();
    await user.keyboard('{Enter}');
    await flush();
    expect(store.getState().slots.find((s) => s.id === 's-3')?.state).toBe('focus');
  });

  it('the bar asks the dock for room for its slots, and the drawer for 880 by 520', async () => {
    const { bridge } = await renderApp();
    const user = userEvent.setup();
    expect(bridge.lastGeometry).toMatchObject({ width: 646, height: 44, expanded: false });
    await user.click(screen.getByRole('button', { name: '展开工作台' }));
    expect(bridge.lastGeometry).toMatchObject({ width: 880, height: 520, expanded: true });
  });
});
