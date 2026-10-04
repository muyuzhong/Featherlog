import type {
  BusError,
  Dispose,
  Envelope,
  EventListener,
  EventType,
  RequestType,
  ResponsePayload,
  UiBus,
} from '@featherlog/contracts';

/**
 * The window side of the IPC bridge (design §6.1). In Electron this is backed by
 * the preload API; in the playground by an in-memory kernel.
 */
export interface BusTransport {
  send(envelope: Envelope): void;
  onDeliver(listener: (envelope: Envelope) => void): Dispose;
  subscribe(types: string[]): void;
  unsubscribe(types: string[]): void;
}

// The kernel owns request timeouts; this only guards against a transport that
// never answers at all.
const TRANSPORT_GRACE_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5000;

type Pending = { resolve(data: unknown): void; reject(error: BusError): void; timer: number };

function busError(code: string, message: string, data?: unknown): BusError {
  return Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) }) as BusError;
}

/** A UiBus for one plugin's renderer half, sending as `source`. */
export function createUiBus(transport: BusTransport, source: string): UiBus & { dispose: Dispose } {
  const listeners = new Map<string, Set<(payload: unknown, envelope: Envelope) => unknown>>();
  const pending = new Map<string, Pending>();

  const envelope = (kind: Envelope['kind'], type: string, payload: unknown, causedBy?: string, timeoutMs?: number): Envelope => ({
    v: 1,
    kind,
    type,
    id: crypto.randomUUID(),
    source,
    time: Date.now(),
    payload,
    ...(causedBy === undefined ? {} : { causedBy }),
    // The kernel in the main process enforces the timeout, so it travels with the request.
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  const stopDelivery = transport.onDeliver((message) => {
    if (message.kind === 'response' && message.replyTo) {
      const entry = pending.get(message.replyTo);
      if (!entry) return;
      pending.delete(message.replyTo);
      window.clearTimeout(entry.timer);
      const result = message.payload as ResponsePayload;
      if (result.ok) entry.resolve(result.data);
      else entry.reject(busError(result.error.code, result.error.message, result.error.data));
      return;
    }
    if (message.kind !== 'event') return;
    for (const listener of [...(listeners.get(message.type) ?? [])]) {
      queueMicrotask(() => {
        try {
          void Promise.resolve(listener(message.payload, message)).catch((cause) => console.error(cause));
        } catch (cause) {
          console.error(cause);
        }
      });
    }
  });

  return {
    emit(type, payload, options) {
      transport.send(envelope('event', type, payload, options?.causedBy));
    },

    on<K extends EventType>(type: K, listener: EventListener<K>): Dispose {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
        transport.subscribe([type]);
      }
      const entry = listener as (payload: unknown, envelope: Envelope) => unknown;
      set.add(entry);
      return () => {
        if (!set.delete(entry) || set.size) return;
        listeners.delete(type);
        transport.unsubscribe([type]);
      };
    },

    request<K extends RequestType>(type: K, payload: unknown, options?: { timeoutMs?: number; causedBy?: string }) {
      const message = envelope('request', type, payload, options?.causedBy, options?.timeoutMs);
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.delete(message.id);
          reject(busError('timeout', `Request ${type} got no reply`));
        }, (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS) + TRANSPORT_GRACE_MS);
        pending.set(message.id, { resolve, reject, timer });
        transport.send(message);
      });
    },

    dispose() {
      stopDelivery();
      for (const [id, entry] of pending) {
        window.clearTimeout(entry.timer);
        entry.reject(busError('disposed', `Bus for ${source} was disposed`));
        pending.delete(id);
      }
      if (listeners.size) transport.unsubscribe([...listeners.keys()]);
      listeners.clear();
    },
  } as UiBus & { dispose: Dispose };
}
