import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { flush, MIN, renderApp } from '../test/fixtures';

const trayChips = () => within(screen.getByRole('list', { name: '并发工作槽' })).getAllByRole('listitem');
const card = (n: number) => screen.getByRole('article', { name: new RegExp(`^${n}\\. `) });
const rowOf = (title: string) => {
  const tasks = screen.getByRole('list', { name: '待办列表' });
  const li = within(tasks).getByDisplayValue(title).closest('li');
  if (!li) throw new Error(`no row for ${title}`);
  return li;
};
const values = (els: HTMLElement[]) => els.map((el) => (el as HTMLTextAreaElement).value);

describe('collapsed tray', () => {
  it('tells the three states apart by surface and type, with an inverted 待看 label', async () => {
    await renderApp();
    const chips = trayChips();
    expect(chips.map((c) => c.dataset.state)).toEqual(['focus', 'running', 'ready']);
    expect(within(chips[0]!).getByRole('button', { pressed: true }).getAttribute('aria-label')).toBe('1. 底部卡槽的展开动画，专注中');
    expect(chips[0]!.querySelector('.tray-plate')).not.toBeNull();
    expect(within(chips[1]!).getByText('14m').className).toContain('tnum');
    expect(within(chips[2]!).getByText('待看').className).toBe('ready-tag');
    expect(screen.getByRole('button', { name: '待办：完成 1，共 8' }).textContent).toBe('1/8');
  });

  it('a click focuses a slot, and the old focus goes back to running', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    await user.click(within(trayChips()[2]!).getByRole('button', { name: /^3\. / }));
    await flush();
    expect(store.getState().slots.map((s) => s.state)).toEqual(['running', 'running', 'focus']);
    expect(trayChips()[2]!.dataset.state).toBe('focus');
  });

  it('a double-click opens the drawer at that slot', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    await user.dblClick(within(trayChips()[1]!).getByRole('button', { name: /^2\. / }));
    await flush();
    expect(store.getState().ui.expanded).toBe(true);
    expect(card(2).dataset.highlight).toBe('true');
  });

  it('a right-click offers 挂起 / 待看 / 完成 in place', async () => {
    const { store } = await renderApp();
    const user = userEvent.setup();
    fireEvent.contextMenu(trayChips()[0]!);
    await user.click(within(trayChips()[0]!).getByRole('button', { name: '挂起' }));
    await flush();
    expect(store.getState().slots[0]?.state).toBe('running');
    fireEvent.contextMenu(trayChips()[2]!);
    await user.click(within(trayChips()[2]!).getByRole('button', { name: '完成' }));
    await flush();
    expect(store.getState().slots.map((s) => s.id)).toEqual(['s-1', 's-2']);
    await waitFor(() => expect(trayChips()).toHaveLength(2));
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

  it('switches between 纸石 and 石墨', async () => {
    await renderApp({ expanded: true });
    const user = userEvent.setup();
    expect(document.documentElement.dataset.theme).toBe('stone');
    await user.click(screen.getByRole('radio', { name: '石墨暗色' }));
    await flush();
    expect(document.documentElement.dataset.theme).toBe('graphite');
  });

  it('the bar asks the dock for room for its slots, and the drawer for 880 by 520', async () => {
    const { bridge } = await renderApp();
    const user = userEvent.setup();
    expect(bridge.lastGeometry).toMatchObject({ width: 646, height: 44, expanded: false });
    await user.click(screen.getByRole('button', { name: '展开工作台' }));
    expect(bridge.lastGeometry).toMatchObject({ width: 880, height: 520, expanded: true });
  });
});
