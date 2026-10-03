import type { Dispose, ObjectiveDraft, QuestInput, ScribeEpilogue, ScribeLine, ScribeState, UiBus } from '@featherlog/contracts';
import { useSyncExternalStore } from 'react';

/*
 * The quest journal's window onto the scribe 翎 (design §14). Everything goes
 * over the bus; when the scribe plugin isn't there, its requests have no
 * handler and every scribe affordance in the journal simply stays hidden.
 */

export type ScribeView = {
  /** The scribe plugin answered at all. */
  present: boolean;
  state: ScribeState | null;
  /** The latest thing 翎 said, in any window. */
  latest: ScribeLine | null;
};

/** Ready to be asked for drafts: enabled, consented, configured, not paused. */
export const canAsk = (view: ScribeView) =>
  !!view.state && view.state.enabled && view.state.consented && view.state.configured && !view.state.paused;

export function createScribeLink(bus: UiBus) {
  let view: ScribeView = { present: false, state: null, latest: null };
  const listeners = new Set<() => void>();
  const epilogueListeners = new Set<(epilogue: ScribeEpilogue) => void>();
  const set = (patch: Partial<ScribeView>) => {
    view = { ...view, ...patch };
    listeners.forEach((listener) => listener());
  };

  bus.request('scribe/state', {}).then(
    (state) => set({ present: true, state }),
    // No scribe plugin (or it failed to load): the journal works on its own.
    () => {},
  );
  const stops: Dispose[] = [
    bus.on('scribe/state-changed', ({ state }) => set({ present: true, state })),
    bus.on('scribe/said', ({ line }) => set({ present: true, latest: line })),
    bus.on('scribe/epilogue-written', ({ epilogue }) => epilogueListeners.forEach((listener) => listener(epilogue))),
  ];

  return {
    subscribe(listener: () => void): Dispose {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => view,
    draft: (text: string): Promise<{ input: QuestInput; note?: string }> => bus.request('scribe/draft-quest', { text }),
    split: (questId: string, objectiveId: string): Promise<{ objectives: ObjectiveDraft[]; note?: string }> =>
      bus.request('scribe/split-objective', { questId, objectiveId }),
    lines: async (questId: string, limit = 2): Promise<ScribeLine[]> =>
      (await bus.request('scribe/lines', { questId, limit })).lines,
    epilogue: async (questId: string): Promise<ScribeEpilogue | null> => (await bus.request('scribe/epilogue', { questId })).epilogue,
    onEpilogue(listener: (epilogue: ScribeEpilogue) => void): Dispose {
      epilogueListeners.add(listener);
      return () => epilogueListeners.delete(listener);
    },
    dispose() {
      stops.forEach((stop) => stop());
      listeners.clear();
      epilogueListeners.clear();
    },
  };
}

export type ScribeLink = ReturnType<typeof createScribeLink>;

export function useScribe(link: ScribeLink): ScribeView {
  return useSyncExternalStore(link.subscribe, link.getSnapshot);
}

/** What went wrong when asking 翎, in words for the page. */
export function scribeTrouble(cause: unknown): string {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  switch (code) {
    case 'scribe/not-configured':
      return '翎还没备好笔墨：先在设置里配置接口和模型';
    case 'scribe/no-consent':
      return '翎还在等你点头：先在"札记"里看看说明';
    case 'scribe/auth-failed':
      return '接口拒绝了这把钥匙，去设置里看看 API Key';
    case 'scribe/unavailable':
      return '一时联系不上接口，过会儿再试';
    case 'scribe/unusable-reply':
      return '翎没写成，换个说法试试';
    default:
      return '翎没能回话，过会儿再试';
  }
}
