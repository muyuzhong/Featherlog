import type { BusErrorInfo, Envelope, Json } from './envelope';
import type {
  EventPayload,
  EventType,
  RequestPayload,
  RequestType,
  ResponseData,
} from './index';

export type Dispose = () => void;

export interface EmitOptions {
  causedBy?: string;
}

export interface RequestOptions {
  /** Defaults to 5000 ms. */
  timeoutMs?: number;
  causedBy?: string;
}

export type EventListener<K extends EventType> = (
  payload: EventPayload<K>,
  envelope: Envelope<EventPayload<K>>,
) => void | Promise<void>;

export type RequestHandler<K extends RequestType> = (
  payload: RequestPayload<K>,
  envelope: Envelope<RequestPayload<K>>,
) => ResponseData<K> | Promise<ResponseData<K>>;

/**
 * The bus as a plugin sees it. `source` is filled in from the plugin id and
 * every registration is released automatically when the plugin unloads.
 */
export interface Bus {
  /** Fire-and-forget. Listeners run asynchronously and cannot affect each other. */
  emit<K extends EventType>(type: K, payload: EventPayload<K>, options?: EmitOptions): void;

  on<K extends EventType>(type: K, listener: EventListener<K>): Dispose;

  /**
   * Resolves with the handler's result. Rejects with a {@link BusError}:
   * "no-handler" immediately if nobody handles `type`, "timeout" after
   * `timeoutMs`, or the code the handler threw.
   */
  request<K extends RequestType>(
    type: K,
    payload: RequestPayload<K>,
    options?: RequestOptions,
  ): Promise<ResponseData<K>>;

  /** Throws synchronously if another handler for `type` is already registered. */
  handle<K extends RequestType>(type: K, handler: RequestHandler<K>): Dispose;
}

/** Renderer-side bus: windows may emit, listen and request, but never handle requests. */
export type UiBus = Omit<Bus, 'handle'>;

/**
 * What `Bus.request` rejects with. A handler that throws an Error carrying a
 * string `code` has that code forwarded to the requester; anything else
 * becomes "handler-error".
 */
export interface BusError extends Error, BusErrorInfo {
  data?: Json;
}
