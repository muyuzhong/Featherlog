import type { Dispose } from './bus';
import type { Envelope, Json } from './envelope';

/**
 * What the preload script exposes as `window.featherlog` (design §6.4).
 * Implemented in packages/shell/src/preload, used by packages/shell/src/renderer.
 */
export interface FeatherlogPreload {
  readonly window: { readonly kind: WindowKind };
  /** The raw bus transport of design §6.3; the renderer wraps it in a UiBus. */
  readonly bus: {
    send(envelope: Envelope): void;
    onDeliver(listener: (envelope: Envelope) => void): Dispose;
    subscribe(types: string[]): void;
    unsubscribe(types: string[]): void;
  };
  readonly settings: {
    /** Every scope's values with defaults applied: `{ shell: {...}, quest: {...} }`. */
    all(): Promise<Record<string, Record<string, Json>>>;
    /** Validated against the scope's schema; rejects with code "shell/invalid-setting". */
    set(scope: string, key: string, value: Json): Promise<void>;
    onChange(listener: (scope: string, key: string, value: Json) => void): Dispose;
  };
  /** Collapsed window only. */
  readonly dock: {
    /** Resize the window to fit its content; the shell keeps the scroll itself in place (design §9.3). */
    resize(size: { width: number; height: number; expanded: boolean }): void;
    /** Show the native context menu (open journal, settings, quit). */
    menu(): void;
    /**
     * Which side the preview unfolds to, from where the scroll sits on its screen
     * (design §9.3). Optional for shells that predate it; treat absence as "left".
     */
    side?(): Promise<UnfoldSide>;
    onSide?(listener: (side: UnfoldSide) => void): Dispose;
  };
  /** Panel window only. */
  readonly panel: {
    /** Hide the panel (it is kept alive for a fast reopen). */
    close(): void;
  };
  readonly platform: {
    readonly os: 'linux' | 'darwin' | 'win32';
    readonly dock: DockCapabilities;
  };
}

export type WindowKind = 'collapsed' | 'panel';

/** The preview unfolds away from the nearer screen edge. */
export type UnfoldSide = 'left' | 'right';

export interface DockCapabilities {
  /** The shell pins the window to a position. Always false in v1: the scroll floats and the user drags it (design §9). */
  anchored: boolean;
  /** It stays above other windows. */
  keepAbove: boolean;
  /** Showing it never takes keyboard focus from the window the user is typing in. */
  focusSafe: boolean;
}
