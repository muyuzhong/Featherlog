import type { KernelEvents, KernelRequests } from './kernel';
import type { QuestEvents, QuestRequests } from './quest';
import type { ShellEvents, ShellRequests } from './shell';

export type * from './bus';
export type * from './envelope';
export type * from './kernel';
export type * from './plugin';
export type * from './preload';
export type * from './quest';
export type * from './shell';
export type * from './slots';

/**
 * Registry of every known event type → payload. A third-party plugin adds its
 * own contracts by augmentation:
 *
 *   declare module '@featherlog/contracts' {
 *     interface EventMap { 'myplugin/done': { id: string } }
 *   }
 */
export interface EventMap extends KernelEvents, ShellEvents, QuestEvents {}

/** Registry of every known request type → `{ req, res }`. Augmented the same way. */
export interface RequestMap extends KernelRequests, ShellRequests, QuestRequests {}

export type EventType = keyof EventMap & string;
export type RequestType = keyof RequestMap & string;
export type EventPayload<K extends EventType> = EventMap[K];
export type RequestPayload<K extends RequestType> = RequestMap[K] extends { req: infer R } ? R : never;
export type ResponseData<K extends RequestType> = RequestMap[K] extends { res: infer R } ? R : never;
