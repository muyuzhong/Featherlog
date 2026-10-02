import type { IsoDateTime, Json } from './envelope';
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

/**
 * The auto-updater (design §12.2). `current` is the running version. Updates
 * are downloaded and installed by the app itself only where it can replace
 * itself; elsewhere a new version is `manual`: the user downloads it.
 */
export type UpdateState = { current: string } & (
  /** Not checked yet in this run. */
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'latest'; checkedAt: IsoDateTime }
  /** 0..100. */
  | { status: 'downloading'; version: string; percent: number }
  /** Downloaded; installed on quit, or now with "shell/apply-update". `notes` is plain text. */
  | { status: 'ready'; version: string; notes?: string }
  /** This install can't replace itself: "shell/apply-update" opens `url` (the release page). */
  | { status: 'manual'; version: string; url: string; notes?: string }
  | { status: 'error'; message: string; checkedAt: IsoDateTime }
  /** A development build: never checks. */
  | { status: 'unsupported' }
  /** Installed by a system package manager (e.g. pacman from the AUR), which updates it: never checks. */
  | { status: 'managed' }
);

/** "shell/*" belongs to the Electron shell. */
export interface ShellEvents {
  /** `tabId`/`params` accompany view "panel": the tab to show and its "shell/open-panel" params. */
  'shell/view-changed': { view: ShellView; previewId?: string; tabId?: string; params?: Json };
  'shell/badge-changed': { iconId: string; badge: Badge | null };
  /** A "shell/notify" to display; `id` is unique per notification. */
  'shell/notified': { id: string; notification: ShellNotification };
  /** Every change of the updater's state; download progress at most every 500 ms. */
  'shell/update-changed': UpdateState;
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
  /** Acknowledge first, then quit through normal plugin cleanup and storage flushing. */
  'shell/quit': { req: Record<string, never>; res: null };
  'shell/set-badge': { req: { iconId: string; badge: Badge | null }; res: null };
  'shell/notify': { req: ShellNotification; res: null };
  'shell/update-state': { req: Record<string, never>; res: UpdateState };
  /** Starts a check and returns at once; results arrive as "shell/update-changed". */
  'shell/check-update': { req: Record<string, never>; res: null };
  /** `ready`: quit and install. `manual`: open the release page. Otherwise rejects with "shell/no-update". */
  'shell/apply-update': { req: Record<string, never>; res: null };
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
