import { afterEach, expect, it, vi } from 'vitest';
import { dialog } from 'electron';
import { createKernel } from '@featherlog/kernel';
import type { MainPlugin } from '@featherlog/kernel';
import type { Clock, Envelope, PluginStorage } from '@featherlog/contracts';
import { loadPlugins, showStartupError } from './startup';
import { plugins } from './plugins';

vi.mock('electron', () => ({ dialog: { showErrorBox: vi.fn() } }));
afterEach(() => vi.clearAllMocks());

function fixture() {
  const timers = new Set<() => void>();
  const clock: Clock = { now: () => 0, setTimeout: callback => {
    timers.add(callback);
    return () => { timers.delete(callback); };
  } };
  const storage: PluginStorage = { get: async () => undefined,
    set: vi.fn(async () => {}), delete: vi.fn(async () => {}), keys: async () => [] };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const kernel = createKernel({ development: true, clock, log, createServices: () => ({
    clock, log, storage, settings: { get: () => undefined, onChange: () => () => {} },
    secrets: { get: async () => undefined, onChange: () => () => {} },
  }) });
  const messages: Envelope[] = [];
  kernel.observe(message => messages.push(message));
  return { kernel, messages, timers, storage };
}

function plugin(id: string, setup: MainPlugin['setup'] = () => {}): MainPlugin {
  return { manifest: { id, name: `${id} plugin`, version: '1.0.0' }, setup };
}

it('starts healthy plugins without an error dialog', async () => {
  const { kernel, messages } = fixture();
  await loadPlugins(kernel, [plugin('healthy')], '0.1.2', '/tmp/Featherlog');
  expect(dialog.showErrorBox).not.toHaveBeenCalled();
  expect(messages.find(message => message.type === 'kernel/ready')?.payload)
    .toEqual({ pluginIds: ['healthy'] });
});

it('reports all setup failures once, preserves their causes and lets healthy plugins load', async () => {
  const { kernel, messages, storage } = fixture();
  const cleaned = vi.fn();
  await loadPlugins(kernel, [
    plugin('alpha', () => { throw Object.assign(new Error('Unsupported schemaVersion'), {
      code: 'alpha/invalid-input',
    }); }),
    plugin('healthy', ctx => { ctx.onDispose(cleaned); }),
    plugin('beta', async () => { throw new Error('Permission denied'); }),
  ], '0.1.2', '/tmp/Featherlog');
  expect(dialog.showErrorBox).toHaveBeenCalledExactlyOnceWith('羽记部分功能启动失败',
    expect.stringContaining('alpha plugin（alpha）无法加载\nalpha/invalid-input: Unsupported schemaVersion'));
  const content = vi.mocked(dialog.showErrorBox).mock.calls[0]![1];
  for (const detail of ['beta plugin（beta）无法加载\nhandler-error: Permission denied',
    '请勿删除或重置原有数据', '应用版本：0.1.2', '数据目录：/tmp/Featherlog',
    'main.log']) expect(content).toContain(detail);
  expect(messages.find(message => message.type === 'kernel/ready')?.payload)
    .toEqual({ pluginIds: ['healthy'] });
  expect(storage.set).not.toHaveBeenCalled();
  expect(storage.delete).not.toHaveBeenCalled();
  kernel.unload('healthy');
  expect(cleaned).toHaveBeenCalledOnce();
});

it('reports setup timeouts and cleans the timed-out plugin', async () => {
  const { kernel, timers } = fixture();
  const cleaned = vi.fn();
  const loading = loadPlugins(kernel, [plugin('slow', ctx => {
    ctx.onDispose(cleaned);
    return new Promise<void>(() => {});
  })], '0.1.2', '/tmp/Featherlog');
  for (const callback of [...timers]) callback();
  await loading;
  expect(dialog.showErrorBox).toHaveBeenCalledExactlyOnceWith('羽记部分功能启动失败',
    expect.stringContaining('timeout: Plugin slow setup timed out'));
  expect(cleaned).toHaveBeenCalledOnce();
  expect(timers.size).toBe(0);
});

it('shows a visible error for unsupported quest data without replacing or deleting it', async () => {
  const { kernel, messages, storage } = fixture();
  vi.spyOn(storage, 'get').mockResolvedValue({ schemaVersion: 3 });
  await loadPlugins(kernel, plugins.filter(plugin => plugin.manifest.id === 'quest'), '0.1.2', '/tmp/Featherlog');
  expect(dialog.showErrorBox).toHaveBeenCalledExactlyOnceWith('羽记部分功能启动失败',
    expect.stringContaining('任务面板（quest）无法加载\nquest/invalid-input: Unsupported quest schemaVersion'));
  expect(messages.find(message => message.type === 'kernel/ready')?.payload)
    .toEqual({ pluginIds: [] });
  expect(storage.set).not.toHaveBeenCalled();
  expect(storage.delete).not.toHaveBeenCalled();
});

it('leaves invalid manifests to the fatal startup error path', async () => {
  const { kernel } = fixture();
  await expect(loadPlugins(kernel, [plugin('INVALID')], '0.1.2', '/tmp/Featherlog'))
    .rejects.toMatchObject({ code: 'invalid-plugin' });
  expect(dialog.showErrorBox).not.toHaveBeenCalled();
  showStartupError('羽记启动失败', 'invalid-plugin: Invalid manifest', '0.1.2', '/tmp/Featherlog');
  expect(dialog.showErrorBox).toHaveBeenCalledExactlyOnceWith('羽记启动失败',
    expect.stringContaining('invalid-plugin: Invalid manifest'));
});
