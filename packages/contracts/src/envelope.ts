/** Any value that survives JSON.stringify → JSON.parse unchanged. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Calendar date in the user's local time zone, "YYYY-MM-DD". */
export type LocalDate = string;

/** ISO 8601 timestamp with offset, e.g. "2026-09-27T08:30:00.000+08:00". */
export type IsoDateTime = string;

export type MessageKind = 'event' | 'request' | 'response';

/**
 * Every message on the bus travels in this envelope, in-process, across IPC
 * and (later) over the local WebSocket bridge.
 */
export interface Envelope<P = unknown> {
  /** Envelope format version. Changes only if the envelope itself changes shape. */
  v: 1;
  kind: MessageKind;
  /** "<module>/<action>", e.g. "quest/completed". A response carries its request's type. */
  type: string;
  /** Unique message id (UUID). */
  id: string;
  /** Sender: a plugin id, "kernel", "shell", or "external:<name>". */
  source: string;
  /** Unix epoch milliseconds. */
  time: number;
  payload: P;
  /** Responses only: id of the request being answered. */
  replyTo?: string;
  /** Id of the message that caused this one. Used for tracing and undo. */
  causedBy?: string;
}

/** Payload of a `kind: "response"` envelope. */
export type ResponsePayload<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: BusErrorInfo };

/** Error codes produced by the kernel itself. Plugins use "<module>/<reason>". */
export type KernelErrorCode =
  | 'no-handler'
  | 'timeout'
  | 'handler-error'
  | 'disposed'
  | 'not-json';

export interface BusErrorInfo {
  /** A KernelErrorCode, or a plugin code such as "quest/not-found". */
  code: KernelErrorCode | (string & {});
  message: string;
  data?: Json;
}
