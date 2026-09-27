import './theme.css';
import deckle from './textures/deckle.png';
import fibers from './textures/fibers.webp';
import leather from './textures/leather.webp';
import stains from './textures/stains.webp';

/** Publishes the texture URLs as CSS custom properties on the document root. */
export function applyTheme(root: HTMLElement = document.documentElement): void {
  const vars: Record<string, string> = {
    '--fl-tex-fibers': fibers,
    '--fl-tex-stains': stains,
    '--fl-tex-leather': leather,
    '--fl-mask-deckle': deckle,
  };
  for (const [name, url] of Object.entries(vars)) root.style.setProperty(name, `url("${url}")`);
}
