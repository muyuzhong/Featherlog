import type { BusErrorInfo } from './envelope';

/** "kernel/*" is reserved for the kernel's own lifecycle events. */
export interface KernelEvents {
  'kernel/plugin-loaded': { pluginId: string; version: string };
  'kernel/plugin-failed': { pluginId: string; error: BusErrorInfo };
  'kernel/plugin-unloaded': { pluginId: string };
  /** All plugins found at startup have finished `setup` (or failed). */
  'kernel/ready': { pluginIds: string[] };
}

export interface KernelRequests {}
