import type { ObjectiveDraft, QuestInput, ScribeBoard, ScribeEpilogue, ScribeLine, ScribeRecap, ScribeState } from '@featherlog/contracts';
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
  // Starts unconsented, so the playground shows the notice of design §14.5 first.
  let consented = false;
  const lines: ScribeLine[] = [];
  const recaps: ScribeRecap[] = [];
  const epilogues = new Map<string, ScribeEpilogue>();
  const state = (): ScribeState => ({
    enabled: true,
    consented,
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
  bus.handle('scribe/consent', ({ granted }) => {
    consented = granted;
    bus.emit('scribe/state-changed', { state: state() });
    return state();
  });
  bus.handle('scribe/test', () => (ready ? { ok: true as const, model: 'demo-model', ms: 420 } : { ok: false as const, code: 'scribe/not-configured' as const, message: '未配置' }));
  bus.handle('scribe/draft-quest', async ({ text }) => {
    if (!ready || !consented) throw notReady();
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
    if (!ready || !consented) throw notReady();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const objectives: ObjectiveDraft[] = [{ text: '先花十分钟读懂题意' }, { text: '写下第一版，哪怕很粗' }, { text: '对照着改一遍' }];
    return { objectives, note: '这一步太大了，拆成三小步，先从最容易的开始。' };
  });
  const periodKey = () => new Date().toISOString().slice(0, 10);
  bus.handle('scribe/board', async (): Promise<ScribeBoard> => {
    const { quests } = await bus.request('quest/list', {});
    const active = quests.filter((q) => q.status === 'active');
    const tracked = active.find((q) => q.tracked);
    const due = active.filter((q) => q.kind === 'side' && q.derived.dueToday && q.id !== tracked?.id);
    const daily = active.find((q) => q.kind === 'daily' && !q.cycle?.done);
    const items: ScribeBoard['items'] = [];
    if (tracked) {
      const objective = tracked.chapters[tracked.derived.chapterIndex]?.objectives[tracked.derived.objectiveIndex];
      items.push({ questId: tracked.id, ...(objective ? { objectiveId: objective.id } : {}), reason: '正追着的这条线，趁热往前推一步。' });
    }
    for (const q of due.slice(0, 1)) items.push({ questId: q.id, reason: '今天到期，先了了它，心里轻松。' });
    if (daily) items.push({ questId: daily.id, reason: '每日的小事，十分钟就够。' });
    return { periodKey: periodKey(), items: items.slice(0, 3), origin: ready && consented ? 'model' : 'builtin' };
  });
  bus.handle('scribe/recap', async ({ write }) => {
    const existing = recaps.find((r) => r.periodKey === periodKey()) ?? null;
    if (existing || !write) return { recap: existing };
    if (!ready || !consented) throw notReady();
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const recap: ScribeRecap = {
      periodKey: periodKey(),
      text: '今天你在「内存之王」里又往前走了一步，持久化这一章只剩最后几道坎。每日委托完成了一半，晨跑和冥想都没落下。明天先把 AOF 重写动手试一遍，趁记忆还热。',
      writtenAt: new Date().toISOString(),
    };
    recaps.unshift(recap);
    bus.emit('scribe/recap-written', { recap });
    return { recap };
  });
  bus.handle('scribe/recaps', () => ({
    recaps: [
      ...recaps,
      {
        periodKey: '2026-10-02',
        text: '昨天把复制的三种拓扑读完了，笔记写得工整。断了一天晨跑，不碍事，今天接着来。',
        writtenAt: '2026-10-02T14:00:00.000Z',
      },
    ],
  }));
  bus.handle('scribe/epilogue', ({ questId }) => ({ epilogue: epilogues.get(questId) ?? null }));
  bus.handle('scribe/lines', ({ questId, limit }) => ({ lines: lines.filter((l) => !questId || l.questId === questId).slice(0, limit ?? 20) }));

  bus.on('quest/objective-completed', ({ quest }) => {
    if (ready && consented) say('objective', pick(LINES.objective), quest.id);
  });
  bus.on('quest/chapter-completed', ({ quest }) => {
    if (ready && consented) say('chapter', pick(LINES.chapter), quest.id);
  });
  bus.on('quest/completed', ({ quest }) => {
    if (!ready || !consented || quest.kind === 'daily') return;
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
