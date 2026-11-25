import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { systemClock } from './lib/clock';
import { detectMode } from './lib/mode';
import { createSoundboard } from './lib/sound';
import { createBridge } from './rpc/bridge';
import { StoreProvider } from './state/react';
import { AppStore, type PrefStorage } from './state/store';
import './styles/tokens.css';
import './styles/app.css';

function prefs(): PrefStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const mode = detectMode();
// Before the first paint, so the opaque panel window never shows a frame of the bar.
document.documentElement.dataset.mode = mode;

const bridge = createBridge();
const soundboard = createSoundboard();
const store = new AppStore({
  bridge,
  mode,
  clock: systemClock,
  prefs: prefs(),
  sound: (cue, settings) => soundboard.play(cue, settings),
});
void store.init();

if (import.meta.env.DEV) Object.assign(globalThis, { __featherlog: { store, bridge } });

const root = document.getElementById('root');
if (!root) throw new Error('featherlog: #root is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
