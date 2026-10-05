import type { CharacterEvents, CharacterRequests } from './character';
import type { KernelEvents, KernelRequests } from './kernel';
import type { NotesEvents, NotesRequests } from './notes';
import type { QuestEvents, QuestRequests } from './quest';
import type { ScribeEvents, ScribeRequests } from './scribe';
import type { ShellEvents, ShellRequests } from './shell';

export type * from './bus';
export type * from './character';
export type * from './envelope';
export type * from './kernel';
export type * from './notes';
export type * from './plugin';
export type * from './preload';
export type * from './quest';
export type * from './scribe';
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
export interface EventMap extends KernelEvents, ShellEvents, QuestEvents, ScribeEvents, NotesEvents, CharacterEvents {}

/** Registry of every known request type → `{ req, res }`. Augmented the same way. */
export interface RequestMap extends KernelRequests, ShellRequests, QuestRequests, ScribeRequests, NotesRequests, CharacterRequests {}

export type EventType = keyof EventMap & string;
export type RequestType = keyof RequestMap & string;
export type EventPayload<K extends EventType> = EventMap[K];
export type RequestPayload<K extends RequestType> = RequestMap[K] extends { req: infer R } ? R : never;
export type ResponseData<K extends RequestType> = RequestMap[K] extends { res: infer R } ? R : never;
