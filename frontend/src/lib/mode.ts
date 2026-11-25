/**
 * How the page is shown.
 *
 * - panel: the host's opaque 880×520 workbench window. The page is always the
 *   drawer and asks the host to hide it instead of collapsing.
 * - bar: the standalone 312×40 drum bar window, for desktops without the KDE
 *   applet (Windows, macOS, GNOME…). It never grows: it opens and closes the
 *   workbench window through DockService.Toggle.
 * - dock: a plain browser tab, where the page draws both the bar and the
 *   drawer and moves between them.
 *
 * An explicit ?mode= wins, so the host can open the bar and the panel from
 * the same build; inside MyGo without one, the page is the panel.
 */
export type AppMode = 'panel' | 'bar' | 'dock';

const MODES: readonly AppMode[] = ['panel', 'bar', 'dock'];

function isMode(value: string | null): value is AppMode {
  return value !== null && (MODES as readonly string[]).includes(value);
}

export function detectMode(scope: object = globalThis, search: string = locationSearch()): AppMode {
  const asked = new URLSearchParams(search).get('mode');
  if (isMode(asked)) return asked;
  const s = scope as { __FEATHERLOG_MYGO__?: unknown; mygo?: unknown };
  return s.__FEATHERLOG_MYGO__ != null || s.mygo != null ? 'panel' : 'dock';
}

function locationSearch(): string {
  try {
    return globalThis.location?.search ?? '';
  } catch {
    return '';
  }
}
