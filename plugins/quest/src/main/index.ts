import type {
  Chapter, Dispose, EventPayload, Json, MainContext, Objective, Quest, QuestEvents, QuestRequests,
  RequestPayload, ResponseData,
} from '@featherlog/contracts';
import {
  chapters, derived, fail, input, nextBoundary, object, patch, periodKey, text, valid,
} from './model';
import type { State, StoredQuest } from './model';

type Transaction = {
  now: number;
  notify<K extends keyof QuestEvents>(type: K, payload: () => EventPayload<K>): void;
  view(quest: StoredQuest): Quest;
};

export async function setup(ctx: MainContext): Promise<void> {
  let disposed = false;
  let ready = false;
  let cancelTimer: Dispose = () => {};
  let tail = Promise.resolve();
  ctx.onDispose(() => {
    disposed = true;
    cancelTimer();
  });
  const setting = () => {
    const value = ctx.settings.get('dayStartHour') ?? 4;
    valid(Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 23,
      'dayStartHour must be an integer from 0 to 23');
    return Number(value);
  };
  let hour = setting();
  // One atomic storage record prevents quests/history/meta from diverging on a failed write.
  const stored = await ctx.storage.get('state');
  if (disposed) return;
  let state: State;
  if (stored === undefined) {
    state = {
      schemaVersion: 1, quests: [], history: {},
      meta: { lastPeriodKey: periodKey(ctx.clock.now(), hour) },
    };
    await ctx.storage.set('state', state as unknown as Json);
  } else {
    object(stored);
    valid(stored.schemaVersion === 1, 'Unsupported quest schemaVersion');
    valid(Array.isArray(stored.quests), 'Invalid stored quests');
    object(stored.history);
    object(stored.meta);
    valid(typeof stored.meta.lastPeriodKey === 'string', 'Invalid stored period');
    for (const value of stored.quests) {
      object(value);
      input({ ...value, chapters: value.kind === 'daily' ? undefined : value.chapters });
      valid(typeof value.id === 'string' && typeof value.createdAt === 'string',
        'Invalid stored quest');
    }
    state = structuredClone(stored) as unknown as State;
  }
  if (disposed) return;

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const job = tail.then(() => {
      valid(!disposed, 'Quest plugin is disposed');
      return work();
    });
    tail = job.then(() => {}, () => {});
    return job;
  };
  const badge = () => {
    if (!ready || disposed) return;
    const tracked = state.quests.find(quest => quest.tracked);
    const value = tracked ? derived(tracked, state, ctx.clock.now(), hour).chapterRatio : 0;
    void ctx.bus.request('shell/set-badge', {
      iconId: 'quest/tracker', badge: tracked ? { kind: 'progress', value } : null,
    }).catch(cause => ctx.log.error('Could not update quest badge', cause));
  };
  const transaction = async <T>(
    work: (draft: State, tx: Transaction) => T,
    causedBy?: string,
  ): Promise<T> => {
    const draft = structuredClone(state);
    const notifications: Array<() => void> = [];
    const now = ctx.clock.now();
    const tx: Transaction = {
      now,
      view: quest => ({ ...structuredClone(quest), derived: derived(quest, draft, now, hour) }),
      notify: (type, payload) => {
        notifications.push(() => ctx.bus.emit(type, payload(),
          causedBy === undefined ? {} : { causedBy }));
      },
    };
    const result = work(draft, tx);
    if (notifications.length) {
      await ctx.storage.set('state', draft as unknown as Json);
      state = draft;
      if (!disposed) {
        for (const notify of notifications) notify();
        badge();
      }
    }
    return result;
  };
  const schedule = () => {
    cancelTimer();
    if (disposed) return;
    const now = ctx.clock.now();
    cancelTimer = ctx.clock.setTimeout(() => {
      void enqueue(() => roll()).catch(cause => {
        ctx.log.error('Could not roll quest period', cause);
      });
    }, nextBoundary(now, hour) - now);
  };
  const roll = async (causedBy?: string) => {
    try {
      const current = periodKey(ctx.clock.now(), hour);
      if (current === state.meta.lastPeriodKey) return;
      await transaction((draft, tx) => {
        const previous = draft.meta.lastPeriodKey;
        for (const quest of draft.quests) {
          if (quest.kind !== 'daily') continue;
          quest.cycle = { periodKey: current, current: 0, done: false };
          quest.updatedAt = new Date(tx.now).toISOString();
        }
        draft.meta.lastPeriodKey = current;
        tx.notify('quest/period-rolled', () => ({ previous, current }));
      }, causedBy);
    } finally {
      schedule();
    }
  };
  await roll();
  if (disposed) return;
  ctx.settings.onChange((key) => {
    if (key !== 'dayStartHour') return;
    void enqueue(async () => {
      hour = setting();
      await roll();
      badge();
    }).catch(cause => ctx.log.error('Could not apply quest settings', cause));
  });
  ctx.bus.on('kernel/ready', () => {
    ready = true;
    badge();
  });

  const find = (draft: State, id: unknown): StoredQuest => {
    const key = text(id, 'quest id', Infinity, true);
    return draft.quests.find(quest => quest.id === key) ??
      fail('quest/not-found', 'Quest not found');
  };
  const editable = (quest: StoredQuest) => {
    valid(quest.status !== 'archived', 'Archived quests cannot be progressed');
  };
  const touch = (quest: StoredQuest, tx: Transaction) => {
    quest.updatedAt = new Date(tx.now).toISOString();
  };
  const untrack = (quest: StoredQuest, tx: Transaction) => {
    if (!quest.tracked) return;
    quest.tracked = false;
    tx.notify('quest/tracked', () => ({ questId: null, previous: quest.id }));
  };
  const history = (draft: State, quest: StoredQuest) => {
    if (!quest.cycle) return;
    const days = new Set(draft.history[quest.id] ?? []);
    if (quest.cycle.done) days.add(quest.cycle.periodKey);
    else days.delete(quest.cycle.periodKey);
    draft.history[quest.id] = [...days].sort();
  };
  const done = (quest: StoredQuest) => quest.kind === 'daily'
    ? quest.cycle!.done : quest.status === 'completed';
  const completed = (draft: State, quest: StoredQuest, tx: Transaction) => {
    if (quest.kind === 'daily') {
      quest.cycle!.done = true;
      history(draft, quest);
    } else {
      quest.status = 'completed';
      quest.completedAt = new Date(tx.now).toISOString();
    }
    touch(quest, tx);
    tx.notify('quest/completed', () => ({
      quest: tx.view(quest),
      ...(quest.cycle ? { periodKey: quest.cycle.periodKey } : {}),
    }));
    untrack(quest, tx);
  };
  const uncompleted = (draft: State, quest: StoredQuest, tx: Transaction) => {
    if (quest.status !== 'archived') quest.status = 'active';
    delete quest.completedAt;
    if (quest.cycle) {
      quest.cycle.done = false;
      history(draft, quest);
    }
    touch(quest, tx);
    tx.notify('quest/uncompleted', () => ({
      quest: tx.view(quest),
      ...(quest.cycle ? { periodKey: quest.cycle.periodKey } : {}),
    }));
  };
  const locate = (quest: StoredQuest, id: unknown): [Chapter, Objective] => {
    const key = text(id, 'objective id', Infinity, true);
    for (const chapter of quest.chapters) {
      const objective = chapter.objectives.find(item => item.id === key);
      if (objective) return [chapter, objective];
    }
    return fail('quest/not-found', 'Objective not found');
  };
  const unlocked = (quest: StoredQuest, objective: Objective) => {
    editable(quest);
    if (quest.chapters.flatMap(chapter => chapter.objectives).find(item => !item.doneAt)
      !== objective) fail('quest/objective-locked', 'Only the current objective is unlocked');
  };
  const finishObjective = (
    draft: State, quest: StoredQuest, chapter: Chapter, objective: Objective, tx: Transaction,
  ) => {
    objective.doneAt = new Date(tx.now).toISOString();
    if (objective.count) objective.count.current = Math.max(
      objective.count.current, objective.count.target);
    touch(quest, tx);
    tx.notify('quest/objective-completed', () => ({
      quest: tx.view(quest), chapterId: chapter.id, objectiveId: objective.id,
    }));
    if (chapter.objectives.every(item => item.doneAt)) {
      chapter.doneAt = new Date(tx.now).toISOString();
      tx.notify('quest/chapter-completed', () => ({
        quest: tx.view(quest), chapterId: chapter.id,
      }));
    }
    if (quest.chapters.every(item => item.objectives.every(o => o.doneAt))) {
      completed(draft, quest, tx);
    }
  };
  const register = <K extends keyof QuestRequests>(
    type: K,
    work: (draft: State, payload: RequestPayload<K>, tx: Transaction) => ResponseData<K>,
  ) => {
    ctx.bus.handle(type, (payload, envelope) => enqueue(async () => {
      await roll(envelope.id);
      object(payload);
      return transaction((draft, tx) => work(draft, payload, tx), envelope.id);
    }));
  };

  register('quest/list', (draft, payload, tx) => {
    const filter = payload.filter ?? {};
    object(filter);
    if (filter.kind !== undefined) valid(typeof filter.kind === 'string' &&
      ['main', 'side', 'daily'].includes(filter.kind), 'Invalid kind');
    if (filter.status !== undefined) valid(typeof filter.status === 'string' &&
      ['active', 'completed', 'archived'].includes(filter.status),
      'Invalid status');
    const kinds = ['main', 'side', 'daily'];
    return { quests: draft.quests.filter(quest =>
      (!filter.kind || quest.kind === filter.kind) &&
      (!filter.status || quest.status === filter.status))
      .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.order - b.order)
      .map(tx.view) };
  });
  register('quest/get', (draft, payload, tx) => ({ quest: tx.view(find(draft, payload.id)) }));
  register('quest/create', (draft, payload, tx) => {
    const fields = input(payload.input);
    const now = new Date(tx.now).toISOString();
    const quest: StoredQuest = {
      ...fields, id: crypto.randomUUID(), status: 'active', priority: fields.priority ?? 'none',
      tracked: false, revealed: false, chapters: chapters(fields.kind, fields.chapters),
      order: draft.quests.filter(q => q.kind === fields.kind)
        .reduce((max, q) => Math.max(max, q.order + 1), 0),
      createdAt: now, updatedAt: now,
      ...(fields.kind === 'daily' ? { cycle: {
        periodKey: draft.meta.lastPeriodKey, current: 0, done: false,
      } } : {}),
    };
    draft.quests.push(quest);
    tx.notify('quest/created', () => ({ quest: tx.view(quest) }));
    return { quest: tx.view(quest) };
  });
  register('quest/update', (draft, payload, tx) => {
    const quest = find(draft, payload.id);
    const wasDone = done(quest);
    const changed = patch(quest, payload.patch);
    if (changed.length) {
      touch(quest, tx);
      tx.notify('quest/updated', () => ({ quest: tx.view(quest), changed }));
      if (quest.cycle && quest.quota) {
        const isDone = quest.cycle.current >= quest.quota.target;
        if (isDone && !wasDone) completed(draft, quest, tx);
        if (!isDone && wasDone) uncompleted(draft, quest, tx);
      }
    }
    return { quest: tx.view(quest) };
  });
  register('quest/set-chapters', (draft, payload, tx) => {
    const quest = find(draft, payload.id);
    editable(quest);
    valid(quest.kind !== 'daily', 'Daily quests cannot have chapters');
    quest.chapters = chapters(quest.kind, payload.chapters, quest.chapters,
      new Date(tx.now).toISOString());
    const allDone = quest.chapters.some(c => c.objectives.length) &&
      quest.chapters.every(c => c.objectives.every(o => o.doneAt));
    for (const chapter of quest.chapters) {
      if (chapter.objectives.length && chapter.objectives.every(o => o.doneAt)) {
        chapter.doneAt ??= new Date(tx.now).toISOString();
      }
    }
    quest.status = allDone ? 'completed' : 'active';
    if (allDone) quest.completedAt ??= new Date(tx.now).toISOString();
    else delete quest.completedAt;
    touch(quest, tx);
    tx.notify('quest/updated', () => ({ quest: tx.view(quest), changed: ['chapters'] }));
    if (allDone) untrack(quest, tx);
    return { quest: tx.view(quest) };
  });
  register('quest/complete-objective', (draft, payload, tx) => {
    const quest = find(draft, payload.id);
    const [chapter, objective] = locate(quest, payload.objectiveId);
    unlocked(quest, objective);
    finishObjective(draft, quest, chapter, objective, tx);
    return { quest: tx.view(quest) };
  });
  register('quest/reopen-objective', (draft, payload, tx) => {
    const quest = find(draft, payload.id);
    editable(quest);
    const [chapter, objective] = locate(quest, payload.objectiveId);
    const wasDone = done(quest);
    let reached = false;
    for (const item of quest.chapters) {
      for (const target of item.objectives) {
        if (target === objective) reached = true;
        if (!reached) continue;
        delete target.doneAt;
        if (target.count) {
          target.count.current = Math.min(target.count.current, target.count.target - 1);
        }
        delete item.doneAt;
      }
    }
    touch(quest, tx);
    tx.notify('quest/objective-reopened', () => ({
      quest: tx.view(quest), chapterId: chapter.id, objectiveId: objective.id,
    }));
    if (wasDone) uncompleted(draft, quest, tx);
    return { quest: tx.view(quest) };
  });
  register('quest/count', (draft, payload, tx) => {
    const quest = find(draft, payload.id);
    editable(quest);
    valid((payload.delta === undefined) !== (payload.set === undefined), 'Use delta or set');
    const amount = payload.delta ?? payload.set;
    valid(Number.isSafeInteger(amount), 'Count must be an integer');
    if (payload.set !== undefined) valid(payload.set >= 0, 'Count cannot be negative');
    let chapter: Chapter | undefined;
    let objective: Objective | undefined;
    if (quest.kind !== 'daily') {
      [chapter, objective] = locate(quest, payload.objectiveId);
      unlocked(quest, objective);
      valid(objective.count, 'Objective is not counted');
    } else {
      valid(payload.objectiveId === undefined && quest.quota, 'A daily quota is required');
    }
    const counter = objective?.count ?? quest.cycle!;
    const previous = counter.current;
    const current = Math.max(0, payload.set ?? previous + payload.delta!);
    valid(Number.isSafeInteger(current), 'Count exceeds safe integer range');
    if (current === previous) return { quest: tx.view(quest) };
    const wasDone = done(quest);
    counter.current = current;
    touch(quest, tx);
    tx.notify('quest/counted', () => ({
      quest: tx.view(quest), previous, current,
      ...(objective ? { objectiveId: objective.id } : {}),
    }));
    if (objective && chapter && current >= objective.count!.target) {
      finishObjective(draft, quest, chapter, objective, tx);
    } else if (quest.kind === 'daily') {
      if (current >= quest.quota!.target && !wasDone) completed(draft, quest, tx);
      if (current < quest.quota!.target && wasDone) uncompleted(draft, quest, tx);
    }
    return { quest: tx.view(quest) };
  });
  register('quest/complete', (draft, payload, tx) => {
    const quest = find(draft, payload.id);
    editable(quest);
    if (done(quest)) return { quest: tx.view(quest) };
    for (const chapter of quest.chapters) {
      for (const objective of chapter.objectives) {
        objective.doneAt ??= new Date(tx.now).toISOString();
        if (objective.count) objective.count.current = Math.max(
          objective.count.current, objective.count.target);
      }
      chapter.doneAt ??= new Date(tx.now).toISOString();
    }
    if (quest.cycle && quest.quota) quest.cycle.current = quest.quota.target;
    completed(draft, quest, tx);
    return { quest: tx.view(quest) };
  });
  register('quest/uncomplete', (draft, payload, tx) => {
    const quest = find(draft, payload.id);
    editable(quest);
    if (!done(quest)) return { quest: tx.view(quest) };
    const chapter = quest.chapters.findLast(item => item.objectives.length > 0);
    const objective = chapter?.objectives.at(-1);
    if (objective && chapter) {
      delete objective.doneAt;
      delete chapter.doneAt;
      if (objective.count) objective.count.current = Math.max(0, objective.count.target - 1);
    }
    if (quest.cycle && quest.quota) quest.cycle.current = Math.max(0, quest.quota.target - 1);
    uncompleted(draft, quest, tx);
    return { quest: tx.view(quest) };
  });
  register('quest/track', (draft, payload, tx) => {
    const quest = payload.id === null ? null : find(draft, payload.id);
    if (quest) {
      valid(quest.status === 'active' && quest.kind !== 'daily',
        'Only active main and side quests can be tracked');
    }
    const previous = draft.quests.find(item => item.tracked);
    if ((previous?.id ?? null) !== (quest?.id ?? null)) {
      if (previous) {
        previous.tracked = false;
        touch(previous, tx);
      }
      if (quest) {
        quest.tracked = true;
        touch(quest, tx);
      }
      tx.notify('quest/tracked', () => ({
        questId: quest?.id ?? null, previous: previous?.id ?? null,
      }));
    }
    return { quest: quest ? tx.view(quest) : null };
  });
  register('quest/archive', (draft, payload, tx) => {
    const quest = find(draft, payload.id);
    if (quest.status !== 'archived') {
      quest.status = 'archived';
      touch(quest, tx);
      tx.notify('quest/updated', () => ({ quest: tx.view(quest), changed: ['status'] }));
      untrack(quest, tx);
    }
    return { quest: tx.view(quest) };
  });
  register('quest/delete', (draft, payload, tx) => {
    const quest = find(draft, payload.id);
    draft.quests = draft.quests.filter(item => item !== quest);
    delete draft.history[quest.id];
    tx.notify('quest/deleted', () => ({ id: quest.id }));
    untrack(quest, tx);
    return null;
  });
  register('quest/reorder', (draft, payload, tx) => {
    valid(Array.isArray(payload.ids) && new Set(payload.ids).size === payload.ids.length,
      'Reorder needs unique ids');
    const quests = payload.ids.map(id => find(draft, id));
    quests.forEach((quest, order) => {
      if (quest.order === order) return;
      quest.order = order;
      touch(quest, tx);
      tx.notify('quest/updated', () => ({ quest: tx.view(quest), changed: ['order'] }));
    });
    return null;
  });
}
