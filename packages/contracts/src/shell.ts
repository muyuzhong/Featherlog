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

/** "shell/*" belongs to the Electron shell. */
export interface ShellEvents {
  'shell/view-changed': { view: ShellView; previewId?: string; tabId?: string };
  'shell/popup-closed': {
    popupId: string;
    type: string;
    result: Json | null;
    reason: 'user' | 'timeout' | 'dismissed';
  };
}

/** Commands have `res: null`: the requester still learns whether anyone handled it. */
export interface ShellRequests {
  'shell/open-panel': { req: { tab?: string; params?: Json }; res: null };
  'shell/set-badge': { req: { iconId: string; badge: Badge | null }; res: null };
  'shell/notify': { req: ShellNotification; res: null };
  /** Queued; at most one popup is visible. Never takes keyboard focus. */
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
