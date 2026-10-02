import { dialog } from 'electron';
import { join } from 'node:path';
import type { KernelEvents } from '@featherlog/contracts';
import type { Kernel, MainPlugin } from '@featherlog/kernel';

export function showStartupError(title: string, details: string, version: string, userData: string) {
  dialog.showErrorBox(title, [
    '启动失败不等于数据为空。请勿删除或重置原有数据。',
    '请确认打开的是正确版本的羽记；如果仍然失败，请反馈以下错误信息。',
    `应用版本：${version}`,
    details,
    `数据目录：${userData}`,
    `日志文件：${join(userData, 'logs', 'main.log')}`,
  ].join('\n\n'));
}

export async function loadPlugins(kernel: Kernel, plugins: MainPlugin[], version: string, userData: string) {
  const failures: KernelEvents['kernel/plugin-failed'][] = [];
  const off = kernel.createBus('shell').on('kernel/plugin-failed', failure => { failures.push(failure); });
  try {
    await kernel.load(plugins);
  } finally {
    off();
  }
  if (!failures.length) return;
  const details = failures.map(({ pluginId, error }) => {
    const name = plugins.find(plugin => plugin.manifest.id === pluginId)?.manifest.name ?? pluginId;
    return `${name}（${pluginId}）无法加载\n${error.code}: ${error.message}`;
  }).join('\n\n');
  showStartupError('羽记部分功能启动失败', details, version, userData);
}
