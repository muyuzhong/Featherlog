/**
 * How the page is shown.
 *
 * - panel: inside the MyGo window. The collapsed bar now lives in a KDE
 *   Plasmoid, and the window is only the opaque 880×520 workbench it pops up,
 *   so the page is always the drawer and asks the host to hide it instead of
 *   collapsing. Also forced with ?mode=panel, to preview that window in a tab.
 * - dock: a plain browser tab, where the page draws both the bottom bar and
 *   the drawer and moves between them.
 */
export type AppMode = 'panel' | 'dock';

export function detectMode(scope: object = globalThis, search: string = locationSearch()): AppMode {
  const s = scope as { __FEATHERLOG_MYGO__?: unknown; mygo?: unknown };
  if (s.__FEATHERLOG_MYGO__ != null || s.mygo != null) return 'panel';
  return new URLSearchParams(search).get('mode') === 'panel' ? 'panel' : 'dock';
}

function locationSearch(): string {
  try {
    return globalThis.location?.search ?? '';
  } catch {
    return '';
  }
}
