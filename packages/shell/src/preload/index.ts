import { contextBridge, ipcRenderer } from 'electron';
import type { DockCapabilities, FeatherlogPreload, Json, UnfoldSide } from '@featherlog/contracts';

const kind = process.argv.includes('--featherlog-window=panel') ? 'panel' : 'collapsed';
const electron = process.argv.includes('--featherlog-dock=electron');
const kwin = process.argv.includes('--featherlog-dock=kwin');
const capabilities: DockCapabilities = {
  anchored: false, keepAbove: electron || kwin, focusSafe: electron,
};
const subscribe = <T extends unknown[]>(channel: string, listener: (...values: T) => void) => {
  const receive = (_event: Electron.IpcRendererEvent, ...values: T) => listener(...values);
  ipcRenderer.on(channel, receive);
  return () => { ipcRenderer.removeListener(channel, receive); };
};
const api: FeatherlogPreload = {
  window: { kind },
  bus: {
    send: envelope => ipcRenderer.send('bus:send', envelope),
    onDeliver: listener => subscribe('bus:deliver', listener),
    subscribe: types => ipcRenderer.send('bus:subscribe', types),
    unsubscribe: types => ipcRenderer.send('bus:unsubscribe', types),
  },
  settings: {
    all: () => ipcRenderer.invoke('settings:all'),
    async set(scope, key, value) {
      // Electron invoke strips custom Error fields; reconstruct the contract's error code here.
      const result: { error?: { code: string; message: string } } =
        await ipcRenderer.invoke('settings:set', scope, key, value);
      // contextBridge strips Error properties too; a JSON rejection preserves the public code.
      if (result.error) throw result.error;
    },
    onChange: listener => subscribe<[string, string, Json]>('settings:changed', listener),
  },
  dock: {
    ...(kind === 'collapsed' ? {
      side: () => ipcRenderer.invoke('dock:side'),
      onSide: (listener: (side: UnfoldSide) => void) =>
        subscribe('dock:side-changed', listener),
    } : {}),
    resize: size => { if (kind === 'collapsed') ipcRenderer.send('dock:resize', size); },
    menu: () => { if (kind === 'collapsed') ipcRenderer.send('dock:menu'); },
  },
  panel: { close: () => { if (kind === 'panel') ipcRenderer.send('panel:close'); } },
  platform: {
    os: process.platform as FeatherlogPreload['platform']['os'], dock: capabilities,
  },
};
contextBridge.exposeInMainWorld('featherlog', api);
