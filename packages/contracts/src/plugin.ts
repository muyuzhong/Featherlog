import type { Bus, Dispose, UiBus } from './bus';
import type { Json } from './envelope';
import type { Contributions, SlotProvider } from './slots';

/**
 * Contents of a plugin's `manifest.json`. Pure JSON so tools (and the future
 * external bridge) can read it without executing plugin code.
 */
export interface PluginManifest {
  /** Lowercase kebab-case. Also the plugin's message namespace: "quest" owns "quest/*". */
  id: string;
  name: string;
  /** Semver. */
  version: string;
  description?: string;
  /** Main-process entry, relative to the manifest. Must export `setup(ctx: MainContext)`. */
  main?: string;
  /** Renderer entry, relative to the manifest. Must export `setup(ctx: UiContext)`. */
  ui?: string;
  /** Message types this plugin emits / listens to / handles / requests. Checked in dev mode only. */
  emits?: string[];
  listens?: string[];
  handles?: string[];
  requests?: string[];
  contributes?: Contributions;
}

export type PluginSetup<C> = (ctx: C) => void | Promise<void>;

/** Per-plugin key–value store. Values must be JSON. Isolated from other plugins. */
export interface PluginStorage {
  get<T extends Json = Json>(key: string): Promise<T | undefined>;
  set(key: string, value: Json): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** Read-only view of this plugin's settings, with defaults from its settings schema. */
export interface PluginSettings {
  get<T extends Json = Json>(key: string): T | undefined;
  onChange(listener: (key: string, value: Json | undefined) => void): Dispose;
}

/** Injected so that time-dependent logic (day rollover, streaks) is testable. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): Dispose;
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/**
 * Everything a plugin's main-process half may touch. Anything registered
 * through it is released when the plugin unloads.
 */
export interface MainContext {
  readonly pluginId: string;
  readonly bus: Bus;
  readonly storage: PluginStorage;
  readonly settings: PluginSettings;
  readonly clock: Clock;
  readonly log: Logger;
  /** Runs when the plugin unloads, in reverse registration order. */
  onDispose(callback: Dispose): void;
}

/** Everything a plugin's renderer half may touch, per window. */
export interface UiContext {
  readonly pluginId: string;
  readonly bus: UiBus;
  readonly slots: SlotProvider;
  readonly settings: PluginSettings;
  readonly log: Logger;
  onDispose(callback: Dispose): void;
}
