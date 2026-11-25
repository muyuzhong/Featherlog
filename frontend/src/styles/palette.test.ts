import { describe, expect, it } from 'vitest';
import app from './app.css?raw';
import tokens from './tokens.css?raw';

// Comments may well say "not red"; only the rules count.
const css = (tokens + app).replace(/\/\*[\s\S]*?\*\//g, '');

/** max - min of the channels: 0 for a pure grey, 255 for a pure hue. */
function spread(r: number, g: number, b: number): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function colours(source: string): Array<{ text: string; spread: number }> {
  const out: Array<{ text: string; spread: number }> = [];
  for (const m of source.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    out.push({ text: m[0], spread: spread(r, g, b) });
  }
  for (const m of source.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/g)) {
    out.push({ text: m[0], spread: spread(Number(m[1]), Number(m[2]), Number(m[3])) });
  }
  return out;
}

describe('no coloured status lights', () => {
  it('uses only near-neutral colours: stone and graphite, no red, amber or green', () => {
    const found = colours(css);
    expect(found.length).toBeGreaterThan(20);
    const coloured = found.filter((c) => c.spread > 16);
    expect(coloured).toEqual([]);
  });

  it('names no hue and runs no breathing or pulsing animation', () => {
    expect(css).not.toMatch(/\b(red|green|lime|orange|amber|yellow|gold|crimson|tomato)\b/i);
    expect(css).not.toMatch(/hsla?\(|oklch\(|@keyframes/i);
  });

  it('draws 待看 as an inverted label in both themes', () => {
    expect(tokens).toMatch(/\[data-theme="stone"\][\s\S]*--label-bg: #18181B;[\s\S]*--label-fg: #FAFAF9;/);
    expect(tokens).toMatch(/\[data-theme="graphite"\][\s\S]*--label-bg: #FAFAF9;[\s\S]*--label-fg: #18181B;/);
    expect(app).toMatch(/\.ready-tag \{[^}]*background: var\(--label-bg\);[^}]*color: var\(--label-fg\);/);
  });

  it('sets the brief\'s surfaces for both themes', () => {
    for (const hex of ['#F6F5F2', '#FFFFFF', '#ECEAE4', '#191918', '#6E6D68']) expect(tokens).toContain(hex);
    for (const hex of ['#121315', '#1C1E22', '#151619', '#F2F2F0', '#858890']) expect(tokens).toContain(hex);
    expect(tokens).toContain('inset 0 1px 0 rgb(255 255 255 / 0.07)');
  });
});
