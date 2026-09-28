import type { FeatherlogPreload } from '@featherlog/contracts';

declare global {
  interface Window {
    /** Exposed by the preload script (design §6.4). */
    featherlog: FeatherlogPreload;
  }
}
