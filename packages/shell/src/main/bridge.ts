import type { Dispose, Envelope, Logger } from '@featherlog/contracts';
import type { Kernel } from '@featherlog/kernel';
import { isJson, record } from './validation';

export interface Peer {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, value: unknown): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

const messageType = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

export function validEnvelope(value: unknown): value is Envelope {
  return record(value) && value.v === 1 && ['event', 'request'].includes(String(value.kind)) &&
    typeof value.kind === 'string' && typeof value.type === 'string' && messageType.test(value.type) &&
    nonempty(value.id) && nonempty(value.source) && typeof value.time === 'number' &&
    Number.isFinite(value.time) && isJson(value.payload) && value.replyTo === undefined &&
    (value.causedBy === undefined || nonempty(value.causedBy));
}

export function createBusBridge(kernel: Pick<Kernel, 'inject' | 'observe'>, log: Logger,
  development: boolean) {
  const peers = new Map<Peer, Set<string>>();
  const pending = new Map<string, Peer>();
  const inFlight = new Set<string>();
  const disposers = new Map<Peer, Dispose>();
  const reset = (peer: Peer) => {
    peers.get(peer)?.clear();
    for (const [id, owner] of pending) if (owner === peer) pending.delete(id);
  };
  const deliver = (peer: Peer, message: Envelope) => {
    if (peer.isDestroyed()) return;
    try { peer.send('bus:deliver', message); }
    catch (cause) { log.error('IPC delivery failed', cause); }
  };
  const stop = kernel.observe(message => {
    if (message.kind === 'event') {
      for (const [peer, types] of peers) {
        if (types.has(message.type) || (development && types.has('*'))) deliver(peer, message);
      }
    } else if (message.kind === 'response' && message.replyTo) {
      const peer = pending.get(message.replyTo);
      pending.delete(message.replyTo);
      inFlight.delete(message.replyTo);
      if (peer) deliver(peer, message);
    }
  });
  return {
    register(peer: Peer): Dispose {
      disposers.get(peer)?.();
      peers.set(peer, new Set());
      const navigation = (...args: unknown[]) => {
        // Electron's did-start-navigation also fires for subframes and same-document changes.
        if (args[3] === true && args[2] === false) reset(peer);
      };
      const dispose = () => {
        reset(peer);
        peers.delete(peer);
        disposers.delete(peer);
        peer.removeListener('destroyed', dispose);
        peer.removeListener('did-start-navigation', navigation);
      };
      disposers.set(peer, dispose);
      peer.on('destroyed', dispose);
      peer.on('did-start-navigation', navigation);
      return dispose;
    },
    receive(peer: Peer, channel: string, payload: unknown): void {
      const types = peers.get(peer);
      if (!types || peer.isDestroyed()) return;
      if (channel === 'bus:subscribe' || channel === 'bus:unsubscribe') {
        if (!Array.isArray(payload) || !payload.every(type => typeof type === 'string' &&
          (messageType.test(type) || (development && type === '*')))) {
          log.warn('Invalid IPC subscription');
          return;
        }
        for (const type of payload as string[]) {
          if (channel === 'bus:subscribe') types.add(type);
          else types.delete(type);
        }
        return;
      }
      if (channel !== 'bus:send' || !validEnvelope(payload)) {
        log.warn('Invalid IPC envelope');
        return;
      }
      if (payload.kind === 'request') {
        if (inFlight.has(payload.id)) {
          log.warn('Duplicate IPC request id');
          return;
        }
        pending.set(payload.id, peer);
        inFlight.add(payload.id);
      }
      const timeoutMs = payload.timeoutMs;
      const message = { ...payload };
      // Windows cannot claim a kernel-generated origin or put invalid metadata on the bus.
      delete message.origin;
      delete message.timeoutMs;
      if (message.kind === 'request' && typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        message.timeoutMs = Math.min(timeoutMs, 120_000);
      }
      try { kernel.inject(message, message.timeoutMs === undefined ? undefined : { timeoutMs: message.timeoutMs }); }
      catch (cause) {
        if (payload.kind === 'request') {
          pending.delete(payload.id);
          inFlight.delete(payload.id);
        }
        log.error('IPC injection failed', cause);
      }
    },
    dispose(): void {
      stop();
      inFlight.clear();
      for (const dispose of [...disposers.values()]) dispose();
    },
  };
}
