import type {
  CharacterMilestone, CharacterSheet, CharacterTitle, ChronicleEntry, Quest, QuestAttribute,
} from '@featherlog/contracts';

export const attributes: QuestAttribute[] = ['learning', 'body', 'mind', 'craft'];
export const attributeNames = ['学识', '体魄', '心性', '技艺'];
export const thresholds = [0, 1, 100, 300, 700, 1500, 3000];
export const rankNames = ['未涉', '初涉', '入门', '小成', '精熟', '大成', '化境'];
export type Account = {
  id: string; kind: Quest['kind']; label: string; attributes: QuestAttribute[];
  points: number; objectives: { id: string; done: boolean; count: number }[];
  chapters: string[]; completed: boolean; periods: string[]; streak: number;
  onTime: boolean; deleted: boolean;
};
export type State = {
  schemaVersion: 1; initialized: boolean; accounts: Account[];
  ranks: number[]; titles: CharacterTitle[]; worn: string | null;
};
export function initialState(): State {
  const fixed = [
    ['first-stroke', '初落笔', '完成第一个目标'],
    ['one-deed', '了却一桩', '完成第一条支线'],
    ['chapter-one', '一章告成', '完成主线的第一章'],
    ['first-volume', '卷终', '完成第一条主线'],
    ['three-volumes', '三卷在握', '完成三条主线'],
    ['seven-days', '晨钟不辍', '任一每日委托连续 7 个应做周期'],
    ['thirty-days', '寒暑不移', '任一每日委托连续 30 个应做周期'],
    ['on-time', '如期', '在限期内完成 5 条主线或支线'],
  ];
  for (const [index, attribute] of attributes.entries()) {
    fixed.push([`${attribute}-3`, ['博览', '筋骨', '定心', '巧手'][index]!, `${attributeNames[index]}达到小成`]);
    fixed.push([`${attribute}-5`, ['鸿儒', '铁骨', '澄明', '匠心'][index]!, `${attributeNames[index]}达到大成`]);
  }
  return { schemaVersion: 1, initialized: false, accounts: [], ranks: [0, 0, 0, 0],
    titles: fixed.map(([id, name, hint]) => ({ id: id!, name: name!, hint: hint! })), worn: null };
}
export function sheet(state: State): CharacterSheet {
  const points = [0, 0, 0, 0];
  let unassigned = 0;
  for (const account of state.accounts) {
    if (!account.attributes.length) unassigned += account.points;
    else account.attributes.forEach((attribute, index) => {
      points[attributes.indexOf(attribute)]! += Math.floor(account.points / account.attributes.length) +
        (index === 0 ? account.points % account.attributes.length : 0);
    });
  }
  return { attributes: attributes.map((attribute, index) => {
    const rank = state.ranks[index]!;
    return { attribute, points: points[index]!, rank, rankName: rankNames[rank]!, rankFrom: thresholds[rank]!,
      ...(rank < 6 ? { nextAt: thresholds[rank + 1]! } : {}) };
  }), unassigned, titles: state.titles, worn: state.worn };
}
type NewEntry = ChronicleEntry extends infer T ? T extends ChronicleEntry ? Omit<T, 'id'> : never : never;
export function entry(value: NewEntry): ChronicleEntry {
  return { ...value, at: new Date(value.at).toISOString(), id: crypto.randomUUID() };
}
export function earnTitle(
  title: CharacterTitle, at: string, entries: ChronicleEntry[], milestones: CharacterMilestone[],
): void {
  if (title.earnedAt) return;
  title.earnedAt = at;
  entries.push(entry({ kind: 'title', titleId: title.id, titleName: title.name, at }));
  milestones.push({ kind: 'title', title: { ...title } });
}
export function milestonesFor(state: State, at: string, entries: ChronicleEntry[]): CharacterMilestone[] {
  const milestones: CharacterMilestone[] = [];
  for (const [index, standing] of sheet(state).attributes.entries()) {
    const rank = thresholds.findLastIndex(threshold => standing.points >= threshold);
    for (let next = state.ranks[index]! + 1; next <= rank; next++) {
      const milestone = { kind: 'rank' as const, attribute: standing.attribute, rank: next, rankName: rankNames[next]! };
      entries.push(entry({ ...milestone, at }));
      milestones.push(milestone);
      state.ranks[index] = next;
    }
  }
  const completed = (kind: Quest['kind']) => state.accounts.filter(account => account.kind === kind && account.completed).length;
  const conditions: Record<string, boolean> = {
    'first-stroke': state.accounts.some(account => account.objectives.some(objective => objective.done)),
    'one-deed': completed('side') >= 1,
    'chapter-one': state.accounts.some(account => account.chapters.length > 0),
    'first-volume': completed('main') >= 1,
    'three-volumes': completed('main') >= 3,
    'seven-days': state.accounts.some(account => account.streak >= 7),
    'thirty-days': state.accounts.some(account => account.streak >= 30),
    'on-time': state.accounts.filter(account => account.onTime).length >= 5,
  };
  for (const [index, attribute] of attributes.entries()) {
    conditions[`${attribute}-3`] = state.ranks[index]! >= 3;
    conditions[`${attribute}-5`] = state.ranks[index]! >= 5;
  }
  for (const title of state.titles) if (conditions[title.id]) earnTitle(title, at, entries, milestones);
  return milestones;
}

export function reconcile(
  state: State, quest: Quest, entries: ChronicleEntry[], completionPeriod?: string,
): Account {
  let account = state.accounts.find(account => account.id === quest.id);
  if (!account) {
    account = { id: quest.id, kind: quest.kind, label: quest.name || quest.title,
      attributes: [...(quest.attributes ?? [])], points: 0, objectives: [], chapters: [],
      completed: false, periods: [], streak: 0, onTime: false, deleted: false };
    state.accounts.push(account);
  }
  if (account.deleted) return account;
  for (const chapter of quest.chapters) {
    for (const objective of chapter.objectives) {
      let unit = account.objectives.find(unit => unit.id === objective.id);
      if (!unit) {
        unit = { id: objective.id, done: false, count: 0 };
        account.objectives.push(unit);
      }
      if (objective.count) {
        const highest = Math.min(20, objective.count.current);
        account.points += Math.max(0, highest - unit.count) * 3;
        unit.count = Math.max(highest, unit.count);
      } else if (objective.doneAt && !unit.done) account.points += 10;
      unit.done ||= Boolean(objective.doneAt);
    }
    if (quest.kind === 'main' && chapter.doneAt && !account.chapters.includes(chapter.id)) {
      account.chapters.push(chapter.id);
      account.points += 20;
      entries.push(entry({ kind: 'chapter-completed', questId: quest.id,
        label: quest.name || quest.title, chapterTitle: chapter.title, at: chapter.doneAt }));
    }
  }
  if (quest.kind !== 'daily' && quest.completedAt && !account.completed) {
    account.completed = true;
    account.points += quest.kind === 'main' ? 60 : 20;
    account.onTime = Boolean(quest.deadline && completionPeriod && completionPeriod <= quest.deadline);
    entries.push(entry({ kind: 'quest-completed', questId: quest.id, questKind: quest.kind,
      label: quest.name || quest.title, at: quest.completedAt }));
  }
  if (quest.kind === 'daily' && quest.cycle) {
    account.streak = Math.max(account.streak, quest.derived.streak);
    const periods = new Set(account.periods);
    if (quest.cycle.done) periods.add(quest.cycle.periodKey);
    // Streaks count due periods, so weekly schedules must skip their off days.
    let remaining = quest.derived.streak;
    const date = new Date(`${quest.cycle.periodKey}T12:00:00`);
    if (!quest.cycle.done) date.setDate(date.getDate() - 1);
    while (remaining > 0) {
      const due = quest.recurrence?.freq === 'daily' ||
        (quest.recurrence?.freq === 'weekly' && quest.recurrence.weekdays.includes(date.getDay()));
      if (due) {
        const key = `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        periods.add(key);
        remaining--;
      }
      date.setDate(date.getDate() - 1);
    }
    account.points += (periods.size - account.periods.length) * 5;
    account.periods = [...periods].sort();
  }
  return account;
}
