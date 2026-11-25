import { describe, expect, it } from 'vitest';
import tokens from '../styles/tokens.css?raw';
import { collapsedWidth, dockGeometry, innerRadius, planResize, SETTLE_MS } from './geometry';

describe('dock geometry', () => {
  it('fits the collapsed bar to its slots between 460 and 900 px', () => {
    expect(collapsedWidth(0)).toBe(460);
    expect(collapsedWidth(3)).toBe(646);
    expect(collapsedWidth(20)).toBe(900);
  });

  it('is 880 by 520 expanded and 44 high collapsed', () => {
    expect(dockGeometry(true, 3, false)).toEqual({ width: 880, height: 520, expanded: true, pinned: false });
    expect(dockGeometry(false, 3, true)).toEqual({ width: 646, height: 44, expanded: false, pinned: true });
  });
});

describe('planResize', () => {
  const collapsed = dockGeometry(false, 3, false);
  const expanded = dockGeometry(true, 3, false);

  it('grows the window before the content springs out', () => {
    expect(planResize(collapsed, expanded)).toEqual([{ delayMs: 0, geom: expanded }]);
  });

  it('shrinks the window only after the content has sprung back', () => {
    expect(planResize(expanded, collapsed)).toEqual([{ delayMs: SETTLE_MS, geom: collapsed }]);
  });

  it('takes the union first when one side grows and the other shrinks', () => {
    const wide = dockGeometry(false, 9, false);
    const steps = planResize(expanded, wide);
    expect(steps[0]).toEqual({ delayMs: 0, geom: { ...wide, width: 900, height: 520 } });
    expect(steps[1]).toEqual({ delayMs: SETTLE_MS, geom: wide });
  });

  it('sends the first geometry at once', () => {
    expect(planResize(null, collapsed)).toEqual([{ delayMs: 0, geom: collapsed }]);
  });
});

describe('concentric corners', () => {
  it('derives every inner radius from its outer radius less the padding', () => {
    expect(innerRadius(22, 8)).toBe(14);
    expect(innerRadius(4, 8)).toBe(0);
    expect(tokens).toContain('--r-section: calc(var(--r-shell) - var(--pad-shell));');
    expect(tokens).toContain('--r-card: calc(var(--r-section) - var(--pad-section));');
    expect(tokens).toContain('--r-chip: calc(var(--r-bar) - var(--pad-bar));');
  });
});
