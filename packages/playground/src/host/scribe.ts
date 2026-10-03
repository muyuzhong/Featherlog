import type { ObjectiveDraft, QuestInput, ScribeEpilogue, ScribeLine, ScribeState } from '@featherlog/contracts';
import type { Kernel } from '@featherlog/kernel';

/*
 * A stand-in for the scribe plugin's main half (design §14): canned words in
 * 翎's voice, so the journal's scribe affordances can be seen without a model.
 */

const LINES = {
  objective: ['这一笔落得干脆。下一步已经摆在眼前了。', '又近了一步。别停，趁手热。', '记下了。照这个速度，这章撑不了几天。'],
  chapter: ['一章合上了。歇口气，下一章的门已经开了。', '这一章走得不容易，翻篇。'],
  quest: ['整条路走完了。这一页我替你收好。'],
} as const;

const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]!;

export function createFakeScribe(kernel: Kernel) {
  const bus = kernel.createBus('scribe');
  let ready = true;
  const lines: ScribeLine[] = [];
  const epilogues = new Map<string, ScribeEpilogue>();
  const state = (): ScribeState => ({
    enabled: true,
    consented: true,
    configured: ready,
    endpoint: 'https://api.example.com/v1',
    usage: { month: new Date().toISOString().slice(0, 7), calls: lines.length, inputTokens: 0, outputTokens: 0, unreported: 0 },
  });
  const say = (topic: ScribeLine['topic'], text: string, questId?: string) => {
    const line: ScribeLine = { id: crypto.randomUUID(), text, topic, at: new Date().toISOString(), origin: 'model', ...(questId ? { questId } : {}) };
    lines.unshift(line);
    // A moment to "think", as a real model would take.
    setTimeout(() => bus.emit('scribe/said', { line }), 900);
  };
  const notReady = () => Object.assign(new Error('Not configured'), { code: 'scribe/not-configured' });

  bus.handle('scribe/state', () => state());
  bus.handle('scribe/consent', () => state());
  bus.handle('scribe/test', () => (ready ? { ok: true as const, model: 'demo-model', ms: 420 } : { ok: false as const, code: 'scribe/not-configured' as const, message: '未配置' }));
  bus.handle('scribe/draft-quest', async ({ text }) => {
    if (!ready) throw notReady();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const goal = text.replace(/^(这个月|这周|今天)?(把|要)?/, '').trim() || text;
    const input: QuestInput = {
      kind: 'main',
      title: goal,
      name: '新的远行',
      story: `你说要「${text}」。路不短，我把它分成了三段，每段先走最要紧的几步。`,
      chapters: [
        { title: '摸清地形', objectives: [{ text: '列出要掌握的要点' }, { text: '挑出最难的三个' }] },
        { title: '逐个击破', objectives: [{ text: '每天啃下一个要点', count: { target: 10, unit: '个' } }] },
        { title: '回头检验', objectives: [{ text: '做一次自测' }, { text: '查漏补缺' }] },
      ],
    };
    return { input, note: '按你说的，我分了三章。哪里不合适，直接改。' };
  });
  bus.handle('scribe/split-objective', async () => {
    if (!ready) throw notReady();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const objectives: ObjectiveDraft[] = [{ text: '先花十分钟读懂题意' }, { text: '写下第一版，哪怕很粗' }, { text: '对照着改一遍' }];
    return { objectives, note: '这一步太大了，拆成三小步，先从最容易的开始。' };
  });
  bus.handle('scribe/board', () => ({ periodKey: new Date().toISOString().slice(0, 10), items: [], origin: 'builtin' as const }));
  bus.handle('scribe/recap', () => ({ recap: null }));
  bus.handle('scribe/recaps', () => ({ recaps: [] }));
  bus.handle('scribe/epilogue', ({ questId }) => ({ epilogue: epilogues.get(questId) ?? null }));
  bus.handle('scribe/lines', ({ questId, limit }) => ({ lines: lines.filter((l) => !questId || l.questId === questId).slice(0, limit ?? 20) }));

  bus.on('quest/objective-completed', ({ quest }) => ready && say('objective', pick(LINES.objective), quest.id));
  bus.on('quest/chapter-completed', ({ quest }) => ready && say('chapter', pick(LINES.chapter), quest.id));
  bus.on('quest/completed', ({ quest }) => {
    if (!ready || quest.kind === 'daily') return;
    say('quest', pick(LINES.quest), quest.id);
    const epilogue: ScribeEpilogue = {
      questId: quest.id,
      text: `「${quest.name ?? quest.title}」走到了头。起初只是一句想法，后来一章一章落了地。这一页我替你收进卷末，往后翻到它，会记得那几个熬过来的晚上。`,
      writtenAt: new Date().toISOString(),
    };
    epilogues.set(quest.id, epilogue);
    setTimeout(() => bus.emit('scribe/epilogue-written', { epilogue }), 1500);
  });

  return {
    get ready() {
      return ready;
    },
    toggle() {
      ready = !ready;
      bus.emit('scribe/state-changed', { state: state() });
    },
  };
}

export type FakeScribe = ReturnType<typeof createFakeScribe>;
