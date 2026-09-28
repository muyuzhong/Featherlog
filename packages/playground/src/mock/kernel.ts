import type { BusTransport } from '@featherlog/shell/renderer';
import type { Dispose, Envelope, ResponsePayload } from '@featherlog/contracts';

type Handler = (payload: unknown, envelope: Envelope) => unknown;

/**
 * A stand-in for the kernel plus the Electron IPC bridge, good enough for the
 * browser playground. Follows design §4 (copy on entry, async delivery,
 * no-handler / timeout) and §6.1 (per-window subscriptions).
 */
export function createMockKernel() {
  const handlers = new Map<string, Handler>();
  const observers = new Set<(envelope: Envelope) => void>();
  const log: Envelope[] = [];

  const freeze = <T,>(value: T): T => {
    if (value && typeof value === 'object') {
      Object.freeze(value);
      Object.values(value).forEach(freeze);
    }
    return value;
  };
  const publish = (envelope: Envelope) => {
    log.push(envelope);
    if (log.length > 400) log.shift();
    for (const observer of [...observers]) queueMicrotask(() => observer(envelope));
  };
  const make = (kind: Envelope['kind'], type: string, payload: unknown, source: string, extra: Partial<Envelope> = {}): Envelope =>
    freeze({ v: 1, kind, type, id: crypto.randomUUID(), source, time: Date.now(), payload: structuredClone(payload), ...extra });

  const respond = (request: Envelope, source: string, payload: ResponsePayload) =>
    publish(make('response', request.type, payload, source, { replyTo: request.id }));

  const dispatch = (request: Envelope) => {
    const handler = handlers.get(request.type);
    if (!handler) {
      respond(request, 'kernel', { ok: false, error: { code: 'no-handler', message: `No handler for ${request.type}` } });
      return;
    }
    Promise.resolve()
      .then(() => handler(request.payload, request))
      .then(
        (data) => respond(request, request.type.split('/')[0]!, { ok: true, data: data ?? null }),
        (cause: { code?: unknown; message?: string }) => {
          const code = typeof cause?.code === 'string' && cause.code.includes('/') ? cause.code : 'handler-error';
          respond(request, request.type.split('/')[0]!, { ok: false, error: { code, message: cause?.message ?? String(cause) } });
        },
      );
  };

  return {
    log,
    handle(type: string, handler: Handler): Dispose {
      if (handlers.has(type)) throw Object.assign(new Error(`Handler already registered for ${type}`), { code: 'duplicate-handler' });
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
    emit(type: string, payload: unknown, source: string, causedBy?: string) {
      publish(make('event', type, payload, source, causedBy ? { causedBy } : {}));
    },
    observe(observer: (envelope: Envelope) => void): Dispose {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    /** One window's end of the bridge. */
    transport(): BusTransport {
      const subscribed = new Set<string>();
      const mine = new Set<string>();
      return {
        send(envelope) {
          const copy = make(envelope.kind, envelope.type, envelope.payload, envelope.source, {
            id: envelope.id,
            ...(envelope.causedBy ? { causedBy: envelope.causedBy } : {}),
          });
          if (copy.kind === 'request') {
            mine.add(copy.id);
            publish(copy);
            dispatch(copy);
          } else publish(copy);
        },
        onDeliver(listener) {
          const observer = (envelope: Envelope) => {
            if (envelope.kind === 'event' && subscribed.has(envelope.type)) listener(envelope);
            if (envelope.kind === 'response' && envelope.replyTo && mine.delete(envelope.replyTo)) listener(envelope);
          };
          observers.add(observer);
          return () => observers.delete(observer);
        },
        subscribe: (types) => types.forEach((type) => subscribed.add(type)),
        unsubscribe: (types) => types.forEach((type) => subscribed.delete(type)),
      };
    },
  };
}

export type MockKernel = ReturnType<typeof createMockKernel>;
