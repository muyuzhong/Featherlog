import './theme.css';
import deckle from './textures/deckle.png';
import leather from './textures/leather.webp';
import aged from './textures/parchment-aged.webp';
import burn from './textures/parchment-burn.webp';
import golden from './textures/parchment-golden.webp';
import vellum from './textures/parchment-vellum.webp';

export type Paper = 'golden' | 'vellum' | 'aged';

export const PAPERS: Record<Paper, { label: string; url: string; base: string }> = {
  vellum: { label: '淡黄', url: vellum, base: '#efdfb9' },
  golden: { label: '金黄', url: golden, base: '#e9d19b' },
  aged: { label: '陈旧', url: aged, base: '#e2c188' },
};

/** How the largest headings are lettered: brush regular script or running script. */
export type TitleScript = 'brush' | 'running';

export const TITLE_SCRIPTS: Record<TitleScript, { label: string }> = {
  brush: { label: '楷书' },
  running: { label: '行书' },
};

const url = (href: string) => `url("${href}")`;

/** Publishes texture URLs as CSS custom properties on the document root. */
export function applyTheme(
  options: { paper?: Paper; titleScript?: TitleScript } = {},
  root: HTMLElement = document.documentElement,
): void {
  root.style.setProperty('--fl-tex-burn', url(burn));
  root.style.setProperty('--fl-tex-leather', url(leather));
  root.style.setProperty('--fl-mask-deckle', url(deckle));
  setPaper(options.paper ?? 'vellum', root);
  setTitleScript(options.titleScript ?? 'brush', root);
}

export function setTitleScript(script: TitleScript, root: HTMLElement = document.documentElement): void {
  root.dataset.flTitle = script;
}

export function setPaper(paper: Paper, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--fl-tex-parchment', url(PAPERS[paper].url));
  root.style.setProperty('--fl-paper', PAPERS[paper].base);
}
