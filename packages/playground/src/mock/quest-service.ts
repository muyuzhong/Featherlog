import type {
  Badge,
  Chapter,
  Objective,
  Quest,
  QuestDerived,
  QuestFilter,
  QuestPatch,
  QuestRequests,
  RequestPayload,
} from '@featherlog/contracts';
import type { MockKernel } from './kernel';
import { seedQuests } from './seed';

type Stored = Omit<Quest, 'derived'>;
type Req<K extends keyof QuestRequests & string> = RequestPayload<K>;

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const toKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/**
 * An in-memory stand-in for the quest plugin's main half (design §8), so the UI
 * can be built before the real one lands.
 */
export function createQuestService(kernel: MockKernel, options: { setBadge(badge: Badge | null): void; dayStartHour?: number }) {
  const dayStartHour = options.dayStartHour ?? 4;
  let dayOffset = 0;
  const now = () => Date.now() + dayOffset * DAY;
  const iso = () => new Date(now()).toISOString();
  const periodKey = (t = now()) => toKey(new Date(t - dayStartHour * 3_600_000));
  const daysAgo = (n: number) => periodKey(now() - n * DAY);

  let quests: Stored[] = seedQuests(periodKey(), daysAgo);
  // Completed periods per daily quest, for streaks. Seeded so the streaks look lived-in.
  const history = new Map<string, Set<string>>();
  for (const q of quests) {
    if (q.kind !== 'daily') continue;
    const days = new Set<string>();
    const length = q.title.startsWith('晨跑') ? 12 : q.title.startsWith('冥想') ? 5 : 3;
    for (let i = 1; i <= length; i++) days.add(daysAgo(i));
    if (q.cycle?.done) days.add(periodKey());
    history.set(q.id, days);
  }
  let lastPeriod = periodKey();

  // ---- derived state -------------------------------------------------------
  const allObjectives = (q: Stored) => q.chapters.flatMap((c) => c.objectives);
  const derive = (q: Stored): QuestDerived => {
    const today = periodKey();
    const chapterIndex = q.chapters.findIndex((c) => c.objectives.some((o) => !o.doneAt));
    const ci = chapterIndex === -1 ? q.chapters.length : chapterIndex;
    const current = q.chapters[ci];
    const objectiveIndex = current ? current.objectives.findIndex((o) => !o.doneAt) : -1;
    const objectives = allObjectives(q);
    const doneCount = objectives.filter((o) => o.doneAt).length;
    let ratio = objectives.length ? doneCount / objectives.length : q.status === 'completed' ? 1 : 0;
    let streak = 0;
    let dueToday = false;
    if (q.kind === 'daily') {
      const target = q.quota?.target ?? 1;
      ratio = q.cycle?.done ? 1 : Math.min(1, (q.cycle?.current ?? 0) / target);
      dueToday = q.status === 'active';
      const days = history.get(q.id) ?? new Set<string>();
      for (let i = 1; days.has(daysAgo(i)); i++) streak++;
      if (q.cycle?.done) streak++;
    } else if (q.status === 'active') {
      dueToday = (q.scheduledFor !== undefined && q.scheduledFor <= today) || (q.deadline !== undefined && q.deadline <= today);
    }
    const chapterRatio = current?.objectives.length
      ? current.objectives.filter((o) => o.doneAt).length / current.objectives.length
      : ci >= q.chapters.length ? 1 : 0;
    return {
      chapterIndex: ci,
      objectiveIndex,
      ratio,
      chapterRatio,
      streak,
      dueToday,
      overdue: q.status === 'active' && q.deadline !== undefined && q.deadline < today,
    };
  };
  const view = (q: Stored): Quest => ({ ...q, derived: derive(q) });

  // ---- helpers ---------------------------------------------------------------
  const find = (id: string) => quests.find((q) => q.id === id) ?? fail('quest/not-found', `No quest ${id}`);
  const save = (next: Stored) => {
    quests = quests.map((q) => (q.id === next.id ? { ...next, updatedAt: iso() } : q));
    return find(next.id);
  };
  const emit = (type: string, payload: unknown, causedBy: string) => kernel.emit(type, payload, 'quest', causedBy);
  const tracked = () => quests.find((q) => q.tracked);
  const syncBadge = () => {
    const t = tracked();
    options.setBadge(t ? { kind: 'progress', value: derive(t).chapterRatio } : null);
  };

  const rollIfNeeded = (causedBy = 'clock') => {
    const current = periodKey();
    if (current === lastPeriod) return;
    const previous = lastPeriod;
    lastPeriod = current;
    quests = quests.map((q) => (q.kind === 'daily' ? { ...q, cycle: { periodKey: current, current: 0, done: false } } : q));
    emit('quest/period-rolled', { previous, current }, causedBy);
    for (const q of quests.filter((q) => q.kind === 'daily')) emit('quest/updated', { quest: view(q), changed: ['cycle'] }, causedBy);
  };

  /** After an objective changed: close chapters/quest as needed and emit the follow-up events. */
  const settle = (q: Stored, causedBy: string, chapterBefore: number) => {
    const d = derive(q);
    if (d.chapterIndex > chapterBefore && q.chapters[chapterBefore]) {
      const closed = q.chapters[chapterBefore]!;
      q = save({ ...q, chapters: q.chapters.map((c) => (c.id === closed.id ? { ...c, doneAt: iso() } : c)) });
      emit('quest/chapter-completed', { quest: view(q), chapterId: closed.id }, causedBy);
    }
    if (d.chapterIndex >= q.chapters.length && q.status === 'active') {
      const wasTracked = q.tracked;
      q = save({ ...q, status: 'completed', completedAt: iso(), tracked: false });
      emit('quest/completed', { quest: view(q) }, causedBy);
      if (wasTracked) emit('quest/tracked', { questId: null, previous: q.id }, causedBy);
    }
    return q;
  };

  const completeObjective = (q: Stored, objectiveId: string, causedBy: string) => {
    const d = derive(q);
    const chapter = q.chapters[d.chapterIndex];
    const objective = chapter?.objectives[d.objectiveIndex];
    if (!chapter || !objective || objective.id !== objectiveId) fail('quest/objective-locked', 'Only the current objective can be completed');
    const patchObjective = (o: Objective): Objective =>
      o.id === objectiveId ? { ...o, doneAt: iso(), ...(o.count ? { count: { ...o.count, current: o.count.target } } : {}) } : o;
    q = save({ ...q, chapters: q.chapters.map((c) => (c.id === chapter.id ? { ...c, objectives: c.objectives.map(patchObjective) } : c)) });
    emit('quest/objective-completed', { quest: view(q), chapterId: chapter.id, objectiveId }, causedBy);
    return settle(q, causedBy, d.chapterIndex);
  };

  const completeDaily = (q: Stored, causedBy: string) => {
    if (q.cycle?.done) return q;
    q = save({ ...q, cycle: { periodKey: periodKey(), current: q.quota?.target ?? 1, done: true } });
    history.get(q.id)?.add(periodKey());
    emit('quest/completed', { quest: view(q), periodKey: periodKey() }, causedBy);
    return q;
  };

  // ---- handlers --------------------------------------------------------------
  const handlers: { [K in keyof QuestRequests & string]?: (payload: Req<K>, requestId: string) => unknown } = {
    'quest/list': ({ filter }: { filter?: QuestFilter }) => ({
      quests: quests
        .filter((q) => (!filter?.kind || q.kind === filter.kind) && (!filter?.status || q.status === filter.status))
        .sort((a, b) => a.order - b.order)
        .map(view),
    }),
    'quest/get': ({ id }) => ({ quest: view(find(id)) }),
    'quest/update': ({ id, patch }: { id: string; patch: QuestPatch }, rid) => {
      const q = find(id);
      const next: Record<string, unknown> = { ...q };
      const changed: string[] = [];
      for (const [key, value] of Object.entries(patch)) {
        if (JSON.stringify(next[key]) === JSON.stringify(value ?? undefined)) continue;
        changed.push(key);
        if (value === null) delete next[key];
        else next[key] = value;
      }
      if (!changed.length) return { quest: view(q) };
      const saved = save(next as Stored);
      emit('quest/updated', { quest: view(saved), changed }, rid);
      return { quest: view(saved) };
    },
    'quest/track': ({ id }, rid) => {
      const previous = tracked();
      if (previous?.id === id) return { quest: id ? view(find(id)) : null };
      if (id) {
        const target = find(id);
        if (target.status !== 'active' || target.kind === 'daily') fail('quest/invalid-input', 'Only an active main or side quest can be tracked');
      }
      quests = quests.map((q) => ({ ...q, tracked: q.id === id }));
      emit('quest/tracked', { questId: id, previous: previous?.id ?? null }, rid);
      return { quest: id ? view(find(id)) : null };
    },
    'quest/complete-objective': ({ id, objectiveId }, rid) => ({ quest: view(completeObjective(find(id), objectiveId, rid)) }),
    'quest/reopen-objective': ({ id, objectiveId }, rid) => {
      let q = find(id);
      const flat = q.chapters.flatMap((c) => c.objectives.map((o) => ({ chapter: c, o })));
      const at = flat.findIndex((x) => x.o.id === objectiveId);
      if (at === -1) fail('quest/not-found', `No objective ${objectiveId}`);
      const reopen = new Set(flat.slice(at).map((x) => x.o.id));
      const chapters: Chapter[] = q.chapters.map((c) => {
        const objectives = c.objectives.map((o): Objective => {
          if (!reopen.has(o.id)) return o;
          const { doneAt: _done, ...rest } = o;
          return rest;
        });
        const { doneAt, ...chapter } = c;
        return objectives.every((o) => o.doneAt) && objectives.length ? { ...chapter, objectives, doneAt: doneAt ?? iso() } : { ...chapter, objectives };
      });
      const wasCompleted = q.status === 'completed';
      const { completedAt: _c, ...rest } = q;
      q = save({ ...(wasCompleted ? rest : q), chapters, status: 'active' });
      emit('quest/objective-reopened', { quest: view(q), chapterId: flat[at]!.chapter.id, objectiveId }, rid);
      if (wasCompleted) emit('quest/uncompleted', { quest: view(q) }, rid);
      return { quest: view(q) };
    },
    'quest/count': ({ id, objectiveId, delta, set }, rid) => {
      let q = find(id);
      if (!objectiveId) {
        const { quota, cycle } = q;
        if (q.kind !== 'daily' || !quota || !cycle) fail('quest/invalid-input', 'Not a daily quest with a quota');
        const previous = cycle.current;
        const current = Math.max(0, Math.min(quota.target, set ?? previous + (delta ?? 1)));
        q = save({ ...q, cycle: { ...cycle, current } });
        emit('quest/counted', { quest: view(q), previous, current }, rid);
        if (current >= quota.target) q = completeDaily(q, rid);
        return { quest: view(q) };
      }
      const d = derive(q);
      const chapter = q.chapters[d.chapterIndex];
      const objective = chapter?.objectives[d.objectiveIndex];
      if (!chapter || !objective || objective.id !== objectiveId) fail('quest/objective-locked', 'Only the current objective can be counted');
      if (!objective.count) fail('quest/invalid-input', 'Objective has no count');
      const previous = objective.count.current;
      const current = Math.max(0, Math.min(objective.count.target, set ?? previous + (delta ?? 1)));
      q = save({
        ...q,
        chapters: q.chapters.map((c) =>
          c.id !== chapter.id ? c : { ...c, objectives: c.objectives.map((o) => (o.id === objectiveId ? { ...o, count: { ...objective.count!, current } } : o)) },
        ),
      });
      emit('quest/counted', { quest: view(q), objectiveId, previous, current }, rid);
      if (current >= objective.count.target) q = completeObjective(q, objectiveId, rid);
      return { quest: view(q) };
    },
    'quest/complete': ({ id }, rid) => {
      let q = find(id);
      if (q.kind === 'daily') return { quest: view(completeDaily(q, rid)) };
      if (q.status === 'completed') return { quest: view(q) };
      if (!allObjectives(q).length) {
        const wasTracked = q.tracked;
        q = save({ ...q, status: 'completed', completedAt: iso(), tracked: false });
        emit('quest/completed', { quest: view(q) }, rid);
        if (wasTracked) emit('quest/tracked', { questId: null, previous: q.id }, rid);
        return { quest: view(q) };
      }
      while (q.status === 'active') {
        const d = derive(q);
        const objective = q.chapters[d.chapterIndex]?.objectives[d.objectiveIndex];
        if (!objective) break;
        q = completeObjective(q, objective.id, rid);
      }
      return { quest: view(q) };
    },
    'quest/uncomplete': ({ id }, rid) => {
      let q = find(id);
      if (q.kind === 'daily') {
        if (!q.cycle?.done) return { quest: view(q) };
        q = save({ ...q, cycle: { ...q.cycle, done: false, current: q.quota ? Math.max(0, q.quota.target - 1) : 0 } });
        history.get(q.id)?.delete(periodKey());
        emit('quest/uncompleted', { quest: view(q), periodKey: periodKey() }, rid);
        return { quest: view(q) };
      }
      if (q.status !== 'completed') return { quest: view(q) };
      const last = allObjectives(q).at(-1);
      if (last) return handlers['quest/reopen-objective']!({ id, objectiveId: last.id }, rid);
      const { completedAt: _c, ...rest } = q;
      q = save({ ...rest, status: 'active' });
      emit('quest/uncompleted', { quest: view(q) }, rid);
      return { quest: view(q) };
    },
  };

  for (const [type, handler] of Object.entries(handlers)) {
    kernel.handle(type, (payload, envelope) => {
      rollIfNeeded(envelope.id);
      const result = (handler as (p: unknown, rid: string) => unknown)(payload, envelope.id);
      queueMicrotask(syncBadge);
      return result;
    });
  }
  queueMicrotask(syncBadge);

  return {
    /** Dev only: pretend a day has passed. */
    nextDay() {
      dayOffset += 1;
      rollIfNeeded();
      syncBadge();
    },
    today: () => periodKey(),
  };
}
