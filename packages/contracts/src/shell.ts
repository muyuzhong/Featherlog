import type { Json } from './envelope';
import type { Badge } from './slots';

/** Which surface is currently shown. */
export type ShellView = 'collapsed' | 'preview' | 'panel';

export interface ShellNotification {
  title: string;
  body?: string;
  /** Lucide icon name. */
  icon?: string;
  variant?: 'success' | 'info' | 'warning';
  /** Defaults to 3000. */
  durationMs?: number;
}

/** Snapshot of the shell's UI state, for a window that has just loaded. */
export interface ShellState {
  view: ShellView;
  badges: Record<string, Badge | null>;
  /** The panel tab last opened, and its params. */
  panel: { tab?: string; params?: Json };
}

/** "shell/*" belongs to the Electron shell. */
export interface ShellEvents {
  /** `tabId`/`params` accompany view "panel": the tab to show and its "shell/open-panel" params. */
  'shell/view-changed': { view: ShellView; previewId?: string; tabId?: string; params?: Json };
  'shell/badge-changed': { iconId: string; badge: Badge | null };
  /** A "shell/notify" to display; `id` is unique per notification. */
  'shell/notified': { id: string; notification: ShellNotification };
  'shell/popup-closed': {
    popupId: string;
    type: string;
    result: Json | null;
    reason: 'user' | 'timeout' | 'dismissed';
  };
}

/** Commands have `res: null`: the requester still learns whether anyone handled it. */
export interface ShellRequests {
  'shell/state': { req: Record<string, never>; res: ShellState };
  'shell/open-panel': { req: { tab?: string; params?: Json }; res: null };
  'shell/set-badge': { req: { iconId: string; badge: Badge | null }; res: null };
  'shell/notify': { req: ShellNotification; res: null };
  /** Queued; at most one popup is visible. Never takes keyboard focus. Not implemented in v1. */
  'shell/show-popup': {
    req: {
      type: string;
      props?: Json;
      priority?: 'low' | 'normal' | 'high';
      autoCloseMs?: number;
    };
    res: { popupId: string };
  };
  'shell/dismiss-popup': { req: { popupId: string }; res: null };
}
