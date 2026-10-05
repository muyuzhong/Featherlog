import type {
  CharacterMilestone, ChronicleEntry, MainContext, Quest, QuestEvents, ShellNotification,
} from '@featherlog/contracts';
import { attributeNames, attributes, earnTitle, milestonesFor, reconcile, sheet } from './model';
import type { State } from './model';
import { instant, object, openState, valid } from './storage';

export async function setup(ctx: MainContext): Promise<void> {
  let disposed = false;
  let ready = false;
  let tail = Promise.resolve();
  ctx.onDispose(() => { disposed = true; });
  const persistence = await openState(ctx.storage, ctx.log);
  if (disposed) return;
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const job = tail.then(() => {
      valid(!disposed, 'Character plugin is disposed');
      return work();
    });
    tail = job.then(() => {}, () => {});
    return job;
  };
  const publish = (next: State, milestones: CharacterMilestone[], silent: boolean) => {
    if (disposed) return;
    ctx.bus.emit('character/changed', { sheet: sheet(next) });
    if (silent) return;
    for (const milestone of milestones) ctx.bus.emit('character/milestone', { milestone });
    const notifications: ShellNotification[] = milestones.slice(0, 3).map(milestone => milestone.kind === 'title'
      ? { title: `得称号「${milestone.title.name}」`, body: milestone.title.hint }
      : { title: `${attributeNames[attributes.indexOf(milestone.attribute)]} · ${milestone.rankName}`,
        body: `历练 ${sheet(next).attributes.find(standing => standing.attribute === milestone.attribute)!.points}` });
    if (milestones.length > 3) notifications.push({ title: `另有 ${milestones.length - 3} 项` });
    for (const notification of notifications) {
      void ctx.bus.request('shell/notify', notification)
        .catch(cause => ctx.log.warn('Could not notify character milestone', cause));
    }
  };
  const commit = async (next: State, entries: ChronicleEntry[], milestones: CharacterMilestone[], silent: boolean) => {
    valid(!disposed, 'Character plugin is disposed');
    if (!entries.length && JSON.stringify(next) === JSON.stringify(persistence.state)) return;
    const changed = JSON.stringify(sheet(next)) !== JSON.stringify(sheet(persistence.state));
    await persistence.save(next, entries);
    if (changed) publish(next, milestones, silent);
  };
  const synchronize = async (snapshot?: Quest, deletedId?: string, startup = false) => {
    const period = await ctx.bus.request('quest/period', {});
    // ponytail: refresh the full journal to resolve stale snapshots; add a revisioned read if journal size warrants it.
    const { quests } = await ctx.bus.request('quest/list', {});
    const next = structuredClone(persistence.state);
    const entries: ChronicleEntry[] = [];
    const at = new Date(ctx.clock.now()).toISOString();
    const credit = (quest: Quest) => {
      const completed = quest.completedAt
        ? new Date(Date.parse(quest.completedAt) - period.dayStartHour * 3_600_000) : undefined;
      const completionPeriod = completed
        ? `${String(completed.getFullYear()).padStart(4, '0')}-${String(completed.getMonth() + 1).padStart(2, '0')}-${String(completed.getDate()).padStart(2, '0')}` : undefined;
      const account = reconcile(next, quest, entries, completionPeriod);
      if (!account.deleted) {
        account.attributes = [...(quest.attributes ?? [])];
        account.label = quest.name || quest.title;
      }
      return account;
    };
    if (snapshot) credit(snapshot);
    for (const quest of quests) credit(quest);
    for (const account of next.accounts) {
      if (account.id === deletedId || (startup && !quests.some(quest => quest.id === account.id))) account.deleted = true;
    }
    const milestones = milestonesFor(next, at, entries);
    next.initialized = true;
    await commit(next, entries, milestones, startup);
  };
  ctx.bus.on('kernel/ready', () => {
    ready = true;
    return enqueue(() => synchronize(undefined, undefined, true));
  });
  const snapshots = [
    'quest/created', 'quest/updated', 'quest/objective-completed', 'quest/objective-reopened',
    'quest/chapter-completed', 'quest/completed', 'quest/uncompleted', 'quest/counted',
  ] as const satisfies readonly (keyof QuestEvents)[];
  for (const type of snapshots) ctx.bus.on(type, payload => {
    if (ready) return enqueue(() => synchronize(payload.quest));
  });
  ctx.bus.on('quest/deleted', payload => {
    if (ready) return enqueue(() => synchronize(undefined, payload.id));
  });
  for (const type of ['quest/tracked', 'quest/period-rolled'] as const) ctx.bus.on(type, () => {
    if (ready) return enqueue(() => synchronize());
  });
  ctx.bus.on('scribe/epilogue-written', payload => {
    if (!ready) return;
    return enqueue(async () => {
      const { epilogue } = payload;
      if (typeof epilogue.title !== 'string' || !epilogue.title.trim()) return;
      const id = `gift:${epilogue.questId}`;
      if (persistence.state.titles.some(title => title.id === id)) return;
      const { quests } = await ctx.bus.request('quest/list', {});
      const quest = quests.find(quest => quest.id === epilogue.questId);
      const account = persistence.state.accounts.find(account => account.id === epilogue.questId);
      if ((quest?.kind ?? account?.kind) !== 'main' || (!quest?.completedAt && !account?.completed)) return;
      const label = quest ? quest.name || quest.title : account!.label;
      const title = { id, name: epilogue.title, hint: `为「${label}」题`, questId: epilogue.questId };
      const next = structuredClone(persistence.state);
      next.titles.push(title);
      const entries: ChronicleEntry[] = [];
      const milestones: CharacterMilestone[] = [];
      earnTitle(title, new Date(ctx.clock.now()).toISOString(), entries, milestones);
      await commit(next, entries, milestones, false);
    });
  });
  ctx.bus.handle('character/sheet', () => enqueue(async () => {
    if (ready && !persistence.state.initialized) await synchronize(undefined, undefined, true);
    return sheet(persistence.state);
  }));
  ctx.bus.handle('character/wear', payload => enqueue(async () => {
    object(payload);
    valid(payload.titleId === null || typeof payload.titleId === 'string', 'Expected a title id or null');
    if (payload.titleId !== null && !persistence.state.titles.some(title => title.id === payload.titleId && title.earnedAt)) {
      throw Object.assign(new Error('Title not earned'), { code: 'character/not-found' });
    }
    const next = { ...persistence.state, worn: payload.titleId };
    await commit(next, [], [], false);
    return sheet(next);
  }));
  ctx.bus.handle('character/chronicle', payload => enqueue(async () => {
    object(payload);
    const before = payload.before === undefined ? Infinity : instant(payload.before);
    const limit = payload.limit === undefined ? 50 : payload.limit;
    valid(Number.isSafeInteger(limit) && limit > 0, 'Limit must be a positive integer');
    const entries = persistence.entries().filter(item => instant(item.at) < before)
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    let end = Math.min(limit, entries.length);
    // A time-only cursor must retain the entire boundary timestamp to avoid dropping ties.
    while (end < entries.length && entries[end]!.at === entries[end - 1]!.at) end++;
    return { entries: entries.slice(0, end), more: entries.length > end };
  }));
}
