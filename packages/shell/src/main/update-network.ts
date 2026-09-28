import type { Session } from 'electron';

const hosts = new Set([
  'github.com', 'api.github.com', 'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export function configureUpdateNetwork(session: {
  webRequest: { [K in 'onBeforeRequest' | 'onBeforeSendHeaders']:
    (...args: Parameters<Session['webRequest'][K]>) => void };
}): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: url.protocol !== 'https:' || !hosts.has(url.hostname) });
  });
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    // electron-updater adds a persistent rollout UUID even for releases without staged rollouts.
    for (const name of Object.keys(headers)) {
      if (['x-user-staging-id', 'cookie', 'authorization'].includes(name.toLowerCase())) {
        delete headers[name];
      }
    }
    callback({ requestHeaders: headers });
  });
}
