import type {
  Bus,
  Clock,
  Dispose,
  Envelope,
  KernelErrorCode,
  Logger,
  MainContext,
  PluginManifest,
  PluginSetup,
  RequestOptions,
  RequestPayload,
  RequestType,
  ResponseData,
  ResponsePayload,
} from '@featherlog/contracts';
import { assertJson, handlerError, kernelError, snapshot } from './messages';

export interface MainPlugin {
  manifest: PluginManifest;
  setup: PluginSetup<MainContext>;
}

export interface KernelOptions {
  development?: boolean;
  setupTimeoutMs?: number;
  clock: Clock;
  log: Logger;
  createServices(pluginId: string): Pick<MainContext, 'storage' | 'settings' | 'clock' | 'log'>;
}

export type Kernel = ReturnType<typeof createKernel>;

type Scope = {
  id: string;
  disposed: boolean;
  cleanups: Set<Dispose>;
};
type Subscription = {
  active: boolean;
  call(payload: unknown, envelope: Envelope): unknown;
};
type Responder = {
  scope: Scope;
  call(payload: unknown, envelope: Envelope): unknown;
};

function failure(code: KernelErrorCode, message: string): ResponsePayload {
  return { ok: false, error: { code, message } };
}

export function createKernel(options: KernelOptions) {
  const listeners = new Map<string, Set<Subscription>>();
  const responders = new Map<string, Responder>();
  const observers = new Set<Subscription>();
  const plugins = new Map<string, Scope>();
  const pending = new Set<{
    sender: Scope | undefined;
    receiver: Scope | undefined;
    cancel: Dispose;
  }>();
  const copy = <T>(value: T): T => snapshot(value, options.development ?? false);
  const guard = (scope: Scope) => {
    if (scope.disposed) throw kernelError('disposed', `Plugin ${scope.id} is disposed`);
  };
  const report = (cause: unknown) => {
    // A broken host logger must not break delivery or resource cleanup.
    try {
      options.log.error('Kernel callback failed', cause);
    } catch {
      // Logging is best effort at this isolation boundary.
    }
  };
  const invoke = (callback: () => unknown) => {
    try {
      const result = callback();
      if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
        'then' in result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(report);
      }
    } catch (cause) {
      report(cause);
    }
  };
  const track = (scope: Scope, callback: Dispose): Dispose => {
    guard(scope);
    const dispose = () => {
      if (!scope.cleanups.delete(dispose)) return;
      callback();
    };
    scope.cleanups.add(dispose);
    return dispose;
  };
  const subscribe = (set: Set<Subscription>, call: Subscription['call']): Dispose => {
    const subscription = { active: true, call };
    set.add(subscription);
    return () => {
      subscription.active = false;
      set.delete(subscription);
    };
  };
  const publish = (envelope: Envelope) => {
    for (const observer of [...observers]) {
      if (observer.active) invoke(() => observer.call(envelope.payload, envelope));
    }
  };
  const envelope = <T>(
    kind: Envelope['kind'],
    type: string,
    payload: T,
    source: string,
    metadata: Pick<Envelope, 'causedBy' | 'replyTo'> = {},
  ): Envelope<T> => {
    const message: Envelope<T> = {
      v: 1,
      kind,
      type,
      payload: copy(payload),
      source,
      id: globalThis.crypto.randomUUID(),
      time: options.clock.now(),
    };
    if (metadata.causedBy !== undefined) message.causedBy = metadata.causedBy;
    if (metadata.replyTo !== undefined) message.replyTo = metadata.replyTo;
    return Object.freeze(message);
  };
  const emit = (message: Envelope) => {
    const targets = [...(listeners.get(message.type) ?? [])];
    if (targets.length) queueMicrotask(() => {
      for (const target of targets) {
        if (target.active) invoke(() => target.call(message.payload, message));
      }
    });
    publish(message);
  };
  const dispatch = (message: Envelope, sender?: Scope, timeoutMs = 5000): Promise<unknown> => {
    const responder = responders.get(message.type);
    return new Promise((resolve, reject) => {
      let settled = false;
      let cancelTimer: Dispose = () => {};
      const entry = {
        sender,
        receiver: responder?.scope,
        cancel: () => finish(failure('disposed', 'Plugin was disposed'), 'kernel'),
      };
      const finish = (payload: ResponsePayload, source: string) => {
        if (settled) return;
        const response = envelope('response', message.type, payload, source, {
          replyTo: message.id,
        });
        settled = true;
        pending.delete(entry);
        cancelTimer();
        publish(response);
        const result = response.payload;
        if (result.ok) resolve(result.data);
        else reject(Object.assign(new Error(result.error.message), result.error));
      };
      if (responder && !responder.scope.disposed) {
        pending.add(entry);
        cancelTimer = options.clock.setTimeout(() => {
          finish(failure('timeout', `Request ${message.type} timed out`), 'kernel');
        }, timeoutMs);
      }
      publish(message);
      if (!responder) {
        finish(failure('no-handler', `No handler for ${message.type}`), 'kernel');
        return;
      }
      if (responder.scope.disposed) entry.cancel();
      if (settled) return;
      const invalidResponse = () => {
        finish(failure('not-json', 'Response data must be cloneable JSON'), 'kernel');
      };
      const failed = (cause: unknown) => {
        if (settled) return;
        try {
          finish({ ok: false, error: handlerError(cause) }, responder.scope.id);
        } catch {
          invalidResponse();
        }
      };
      queueMicrotask(() => {
        if (settled) return;
        try {
          const result = responder.call(message.payload, message);
          const succeeded = (data: unknown) => {
            if (settled) return;
            try {
              finish({ ok: true, data }, responder.scope.id);
            } catch {
              invalidResponse();
            }
          };
          // Synchronous results enter the bus before the responder can mutate them later.
          if (
            result !== null &&
            typeof result === 'object' &&
            'then' in result &&
            typeof result.then === 'function'
          ) {
            void Promise.resolve(result).then(succeeded, failed);
          } else {
            succeeded(result);
          }
        } catch (cause) {
          failed(cause);
        }
      });
    });
  };
  const makeBus = (scope: Scope, plugin: boolean): Bus => {
    const namespace = (type: string) => {
      guard(scope);
      const owned = type.startsWith(`${scope.id}/`) &&
        /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(type.slice(scope.id.length + 1));
      if (options.development && plugin && !owned) {
        throw kernelError(
          'forbidden-namespace',
          `Plugin ${scope.id} cannot publish or handle ${type}`,
        );
      }
    };
    return {
      emit(type, payload, config) {
        namespace(type);
        if (!listeners.get(type)?.size && !observers.size) {
          if (options.development) assertJson(payload);
          return;
        }
        emit(envelope('event', type, payload, scope.id, config));
      },
      on(type, listener) {
        guard(scope);
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        const remove = subscribe(set, listener as Subscription['call']);
        return track(scope, () => {
          remove();
          if (!set.size) listeners.delete(type);
        });
      },
      request<K extends RequestType>(
        type: K,
        payload: RequestPayload<K>,
        config?: RequestOptions,
      ): Promise<ResponseData<K>> {
        const metadata = config?.causedBy === undefined ? {} : { causedBy: config.causedBy };
        const message = envelope('request', type, payload, scope.id, metadata);
        if (scope.disposed) {
          return Promise.reject(kernelError('disposed', `Plugin ${scope.id} is disposed`));
        }
        return dispatch(message, scope, config?.timeoutMs) as Promise<ResponseData<K>>;
      },
      handle(type, handler) {
        namespace(type);
        if (responders.has(type)) {
          throw kernelError('duplicate-handler', `Handler already registered for ${type}`);
        }
        const responder = { scope, call: handler as Responder['call'] };
        responders.set(type, responder);
        return track(scope, () => {
          if (responders.get(type) === responder) responders.delete(type);
        });
      },
    };
  };
  const disposeScope = (scope: Scope) => {
    if (scope.disposed) return;
    scope.disposed = true;
    for (const entry of [...pending]) {
      if (entry.sender === scope || entry.receiver === scope) entry.cancel();
    }
    for (const cleanup of [...scope.cleanups].reverse()) invoke(cleanup);
  };
  const lifecycle = (type: string, payload: unknown) => {
    emit(envelope('event', type, payload, 'kernel'));
  };
  const unload = (pluginId: string) => {
    const scope = plugins.get(pluginId);
    if (!scope) return;
    plugins.delete(pluginId);
    disposeScope(scope);
    lifecycle('kernel/plugin-unloaded', { pluginId });
  };
  const load = async (entries: readonly MainPlugin[]) => {
    const ids = new Set(plugins.keys());
    for (const { manifest } of entries) {
      const id = manifest.id;
      if (
        typeof id !== 'string' ||
        !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) ||
        ['kernel', 'shell', 'external'].includes(id) ||
        ids.has(id)
      ) {
        throw kernelError('invalid-plugin', `Invalid or duplicate plugin id: ${id}`);
      }
      ids.add(id);
    }
    for (const { manifest, setup } of entries) {
      const id = manifest.id;
      const scope: Scope = { id, disposed: false, cleanups: new Set() };
      plugins.set(id, scope);
      let cancelSetupTimer: Dispose = () => {};
      let timedOut = false;
      try {
        const services = options.createServices(id);
        const context: MainContext = {
          pluginId: id,
          bus: makeBus(scope, true),
          storage: services.storage,
          log: services.log,
          settings: {
            get: key => services.settings.get(key),
            onChange: listener => {
              guard(scope);
              return track(scope, services.settings.onChange((key, value) => {
                if (!scope.disposed) invoke(() => listener(key, value));
              }));
            },
          },
          clock: {
            now: () => services.clock.now(),
            setTimeout(callback, ms) {
              guard(scope);
              let dispose: Dispose;
              const cancel = services.clock.setTimeout(() => {
                dispose();
                if (!scope.disposed) invoke(callback);
              }, ms);
              dispose = track(scope, cancel);
              return dispose;
            },
          },
          onDispose: callback => {
            track(scope, callback);
          },
        };
        const deadline = new Promise<never>((_, reject) => {
          cancelSetupTimer = options.clock.setTimeout(() => {
            timedOut = true;
            // Close the scope immediately, before any late setup continuation can register.
            disposeScope(scope);
            reject(kernelError('timeout', `Plugin ${id} setup timed out`));
          }, options.setupTimeoutMs ?? 10_000);
        });
        await Promise.race([setup(context), deadline]);
        if (!scope.disposed) {
          lifecycle('kernel/plugin-loaded', { pluginId: id, version: manifest.version });
        }
      } catch (cause) {
        disposeScope(scope);
        if (plugins.get(id) === scope) plugins.delete(id);
        let info = timedOut
          ? { code: 'timeout', message: `Plugin ${id} setup timed out` }
          : handlerError(cause);
        try {
          info = copy(info);
        } catch {
          info = { code: 'not-json', message: 'Setup error data must be cloneable JSON' };
        }
        lifecycle('kernel/plugin-failed', { pluginId: id, error: info });
      } finally {
        cancelSetupTimer();
      }
    }
    lifecycle('kernel/ready', { pluginIds: [...plugins.keys()] });
  };
  return {
    createBus(source: string): Bus {
      return makeBus({ id: source, disposed: false, cleanups: new Set() }, false);
    },
    observe(callback: (message: Envelope) => void): Dispose {
      return subscribe(observers, (_, message) => callback(message));
    },
    inject(message: Envelope): void {
      const received = Object.freeze({ ...message, payload: copy(message.payload) });
      if (received.kind === 'event') emit(received);
      else if (received.kind === 'request') void dispatch(received).catch(() => {});
      else publish(received);
    },
    load,
    unload,
  };
}
