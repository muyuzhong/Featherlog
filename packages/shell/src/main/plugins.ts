import questManifest from '@featherlog/plugin-quest/manifest.json';
import { setup as questSetup } from '@featherlog/plugin-quest/main';
import scribeManifest from '@featherlog/plugin-scribe/manifest.json';
import { setup as scribeSetup } from '@featherlog/plugin-scribe/main';
import type { MainPlugin } from '@featherlog/kernel';
import type { Envelope } from '@featherlog/contracts';

export function createPlugins() {
  const requests = new Map<string, string>();
  const actors = new WeakMap<Envelope, string>();
  const observe = (message: Envelope) => {
    if (message.kind === 'request') requests.set(message.id, message.source);
    if (message.kind === 'response' && message.replyTo) requests.delete(message.replyTo);
    if (message.kind === 'event' && message.causedBy) {
      const actor = requests.get(message.causedBy);
      // Listeners run after the response may have removed the request; retain only the event's lifetime.
      if (actor) actors.set(message, actor);
    }
  };
  const isLocalAction = (message: Envelope) => {
    const actor = actors.get(message);
    return message.type.startsWith('quest/') ? message.source === 'quest' && actor === 'quest'
      : message.type === 'shell/view-changed' && message.source === 'shell' &&
        (actor === 'quest' || actor === 'shell' || message.causedBy === undefined);
  };
  const plugins: MainPlugin[] = [
    { manifest: questManifest, setup: questSetup },
    { manifest: scribeManifest, setup: ctx => scribeSetup(ctx, { isLocalAction }) },
  ];
  return { plugins, observe, isLocalAction };
}

export const { plugins } = createPlugins();
