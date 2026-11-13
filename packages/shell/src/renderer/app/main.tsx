// Electron renderer entry for both windows (design §6.1).
import './shared-runtime';
import { startWindow } from '.';
import { uiPlugins } from './plugins';
import './window.css';

void startWindow(window.featherlog, uiPlugins, document.getElementById('root')!);
