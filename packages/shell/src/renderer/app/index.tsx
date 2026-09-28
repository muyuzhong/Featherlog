import type { FeatherlogPreload } from '@featherlog/contracts';
import { createRoot } from 'react-dom/client';
import { applyTheme, setPaper, type Paper as ThemePaper } from '../theme';
import { CollapsedApp } from './CollapsedApp';
import { PanelApp } from './PanelApp';
import { createRuntime, type UiPlugin, type WindowRuntime } from './runtime';

export { CollapsedApp } from './CollapsedApp';
export { PanelApp } from './PanelApp';
export { createRuntime, type UiPlugin, type WindowRuntime } from './runtime';

/** Titles are part of the platform contract: KWin finds the dock by its title (design §9.4). */
export const WINDOW_TITLES = { collapsed: 'featherlog-dock', panel: '羽记' } as const;

/** Boots one window: runtime, theme, then the app for this window kind. */
export async function startWindow(preload: FeatherlogPreload, plugins: UiPlugin[], container: HTMLElement): Promise<WindowRuntime> {
  const kind = preload.window.kind;
  document.title = WINDOW_TITLES[kind];
  document.documentElement.dataset.window = kind;
  const runtime = await createRuntime(preload, plugins);
  applyTheme({ paper: runtime.setting<ThemePaper>('shell', 'paper') ?? 'vellum' });
  runtime.onSettingChange((scope, key, value) => {
    if (scope === 'shell' && key === 'paper') setPaper(value as ThemePaper);
  });
  createRoot(container).render(kind === 'collapsed' ? <CollapsedApp runtime={runtime} /> : <PanelApp runtime={runtime} />);
  return runtime;
}

