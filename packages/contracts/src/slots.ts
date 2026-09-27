import type { Dispose } from './bus';
import type { Json } from './envelope';

/*
 * UI slots have two halves:
 *  - declaration: pure JSON in the manifest's `contributes`, so the shell can
 *    lay out icons and tabs before any plugin UI code loads;
 *  - implementation: a mount function the renderer half provides by id.
 */

export interface Contributions {
  collapsedIcons?: CollapsedIconContribution[];
  panelTabs?: PanelTabContribution[];
  popups?: PopupContribution[];
  settings?: SettingsContribution;
}

/** An icon in the collapsed view (edge bar or floating widget). */
export interface CollapsedIconContribution {
  /** "<pluginId>/<name>". */
  id: string;
  title: string;
  /** A Lucide icon name, e.g. "list-checks". */
  icon: string;
  /** Lower comes first. The user's own ordering overrides this. */
  order?: number;
  /** Whether a "collapsed.preview" mount with the same id exists. */
  preview?: boolean;
  /** Panel tab id to open on click. Defaults to the plugin's first tab. */
  opens?: string;
}

export interface PanelTabContribution {
  id: string;
  title: string;
  icon: string;
  order?: number;
}

export interface PopupContribution {
  /** Popup type id, used as `type` in "shell/show-popup". */
  id: string;
  width: number;
  height: number;
}

export interface SettingsContribution {
  title?: string;
  /**
   * JSON Schema (draft 2020-12) for an object. The shell renders a form from
   * it; `default` values seed PluginSettings.
   */
  schema: Json;
}

export type Badge =
  | { kind: 'count'; value: number }
  | { kind: 'dot' }
  /** 0..1, drawn as a ring around the icon. */
  | { kind: 'progress'; value: number };

interface BaseHost {
  readonly slotId: string;
  readonly visible: boolean;
  onShow(listener: () => void): Dispose;
  onHide(listener: () => void): Dispose;
}

export interface PreviewHost extends BaseHost {
  /** Ask the shell to fit the preview to its content. Clamped to the shell's maximum. */
  setHeight(height: number): void;
}

export interface PanelTabHost extends BaseHost {
  /** `params` from the latest "shell/open-panel" that targeted this tab. */
  readonly params: Json | undefined;
  onParamsChange(listener: (params: Json | undefined) => void): Dispose;
}

export interface PopupHost extends BaseHost {
  readonly popupId: string;
  readonly props: Json | undefined;
  /** Closes the popup; `result` is delivered in "shell/popup-closed". */
  close(result?: Json): void;
}

export interface SlotHosts {
  'collapsed.preview': PreviewHost;
  'panel.tab': PanelTabHost;
  popup: PopupHost;
}

export type SlotKind = keyof SlotHosts;

/** Renders into `el`; the returned function (if any) runs on unmount. */
export type Mount<K extends SlotKind> = (el: HTMLElement, host: SlotHosts[K]) => Dispose | void;

export interface SlotProvider {
  /** `id` must match a contribution declared in the manifest. */
  provide<K extends SlotKind>(kind: K, id: string, mount: Mount<K>): Dispose;
}
