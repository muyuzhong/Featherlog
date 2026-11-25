import type { DockGeometry } from '../rpc/types';

/** The collapsed window: a 38px bar inside a 44px window, so shadows and the raised focus card are not clipped. */
export const COLLAPSED = { windowHeight: 44, barHeight: 38, minWidth: 460, maxWidth: 900 } as const;
export const EXPANDED = { width: 880, height: 520 } as const;

/** Room the bar's grip, toggle, quick buttons and tally take, and what each slot chip asks for. */
const TRAY_CHROME = 196;
const TRAY_SLOT = 150;

/** The spring every move uses: snappy, close to critically damped. */
export const SPRING = { type: 'spring', stiffness: 440, damping: 34, mass: 1 } as const;
/** About how long SPRING takes to settle, before a window may shrink under it. */
export const SETTLE_MS = 280;

export function collapsedWidth(slotCount: number): number {
  const wanted = TRAY_CHROME + Math.max(0, slotCount) * TRAY_SLOT;
  return Math.min(COLLAPSED.maxWidth, Math.max(COLLAPSED.minWidth, wanted));
}

export function dockGeometry(expanded: boolean, slotCount: number, pinned: boolean): DockGeometry {
  return expanded
    ? { width: EXPANDED.width, height: EXPANDED.height, expanded: true, pinned }
    : { width: collapsedWidth(slotCount), height: COLLAPSED.windowHeight, expanded: false, pinned };
}

export function sameGeometry(a: DockGeometry, b: DockGeometry): boolean {
  return a.width === b.width && a.height === b.height && a.expanded === b.expanded && Boolean(a.pinned) === Boolean(b.pinned);
}

export interface ResizeStep {
  delayMs: number;
  geom: DockGeometry;
}

/**
 * The window grows before the content springs out, and shrinks only after it
 * springs back, so the page is never cut off mid-animation. A change that
 * grows one side and shrinks the other first takes the larger of both.
 */
export function planResize(prev: DockGeometry | null, next: DockGeometry): ResizeStep[] {
  if (!prev) return [{ delayMs: 0, geom: next }];
  const grows = next.width >= prev.width && next.height >= prev.height;
  if (grows) return [{ delayMs: 0, geom: next }];
  const shrinks = next.width <= prev.width && next.height <= prev.height;
  if (shrinks) return [{ delayMs: SETTLE_MS, geom: next }];
  const union: DockGeometry = { ...next, width: Math.max(prev.width, next.width), height: Math.max(prev.height, next.height) };
  return [
    { delayMs: 0, geom: union },
    { delayMs: SETTLE_MS, geom: next },
  ];
}

/** Concentric corners: a box inside another keeps the same centre of curvature. */
export function innerRadius(outer: number, padding: number): number {
  return Math.max(0, outer - padding);
}
