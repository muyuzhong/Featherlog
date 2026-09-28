import type {
  Chapter, ChapterDraft, Quest, QuestDerived, QuestErrorCode, QuestInput, QuestKind,
  Recurrence,
} from '@featherlog/contracts';

export type StoredQuest = Omit<Quest, 'derived'>;
export type State = {
  schemaVersion: 1;
  quests: StoredQuest[];
  history: Record<string, string[]>;
  meta: { lastPeriodKey: string };
};

export function fail(code: QuestErrorCode, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function valid(condition: unknown, message: string): asserts condition {
  if (!condition) fail('quest/invalid-input', message);
}

export function object(value: unknown): asserts value is Record<string, unknown> {
  valid(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected object');
}

export function text(value: unknown, label: string, max = Infinity, required = false): string {
  valid(typeof value === 'string', `${label} must be a string`);
  const result = value.trim();
  valid((!required || result.length > 0) && result.length <= max, `Invalid ${label}`);
  return result;
}

export function dateKey(time: number): string {
  const date = new Date(time);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1)
    .padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function periodKey(time: number, hour: number): string {
  return dateKey(time - hour * 3_600_000);
}

export function dayTime(key: string): number {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  return date.getTime();
}

export function previousDay(key: string): string {
  const date = new Date(dayTime(key));
  date.setDate(date.getDate() - 1);
  return dateKey(date.getTime());
}

export function nextBoundary(time: number, hour: number): number {
  // Follow the documented elapsed-hour shift, including DST changes.
  const shifted = new Date(time - hour * 3_600_000);
  shifted.setHours(24, 0, 0, 0);
  return shifted.getTime() + hour * 3_600_000;
}

function localDate(value: unknown): string {
  valid(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Invalid date');
  valid(dateKey(dayTime(value)) === value, 'Invalid date');
  return value;
}

function target(value: unknown): asserts value is number {
  valid(Number.isSafeInteger(value) && (value as number) > 0, 'Target must be a positive integer');
}

function countDraft(value: unknown): { target: number; unit?: string } {
  object(value);
  target(value.target);
  return {
    target: value.target,
    ...(value.unit === undefined ? {} : { unit: text(value.unit, 'unit') }),
  };
}

function recurrence(value: unknown): Recurrence {
  object(value);
  if (value.freq === 'daily') return { freq: 'daily' };
  valid(value.freq === 'weekly' && Array.isArray(value.weekdays), 'Invalid recurrence');
  const days = value.weekdays as unknown[];
  valid(days.length > 0 && new Set(days).size === days.length, 'Invalid weekdays');
  valid(days.every(day => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6),
    'Invalid weekday');
  return { freq: 'weekly', weekdays: days as number[] };
}

export function chapters(
  kind: QuestKind, drafts: unknown, old: Chapter[] = [], now?: string,
): Chapter[] {
  if (kind === 'daily') {
    valid(drafts === undefined, 'Daily quests cannot have chapters');
    return [];
  }
  if (kind === 'side' && (drafts === undefined || (Array.isArray(drafts) && !drafts.length))) {
    drafts = [{ title: '', objectives: [] }];
  }
  valid(Array.isArray(drafts), 'Chapters are required');
  valid(kind === 'main' ? drafts.length > 0 : drafts.length === 1, 'Invalid chapter count');
  const ids = new Set<string>();
  const oldObjectives = old.flatMap(chapter => chapter.objectives);
  const identify = (value: unknown) => {
    const id = value === undefined ? crypto.randomUUID() : text(value, 'id', Infinity, true);
    valid(!ids.has(id), 'Duplicate chapter or objective id');
    ids.add(id);
    return id;
  };
  return drafts.map((draft: unknown) => {
    object(draft);
    const id = identify(draft.id);
    const title = text(draft.title, 'chapter title');
    valid(kind !== 'side' || title === '', 'Side chapters must be untitled');
    valid(Array.isArray(draft.objectives), 'Objectives must be an array');
    valid(kind !== 'main' || draft.objectives.length > 0, 'Main chapters need objectives');
    const objectives = draft.objectives.map((item: unknown) => {
      object(item);
      const objectiveId = identify(item.id);
      const previous = oldObjectives.find(objective => objective.id === objectiveId);
      const count = item.count === undefined ? undefined : countDraft(item.count);
      const current = count ? previous?.count?.current ?? 0 : 0;
      const doneAt = previous?.doneAt ?? (count && current >= count.target ? now : undefined);
      // Keep accumulated progress when targets change; completion still satisfies the quota.
      return {
        id: objectiveId,
        text: text(item.text, 'objective text', Infinity, true),
        ...(item.detail === undefined ? {} : { detail: text(item.detail, 'objective detail') }),
        ...(count ? { count: { ...count, current: previous?.doneAt
          ? Math.max(current, count.target) : current } } : {}),
        ...(doneAt ? { doneAt } : {}),
      };
    });
    const previous = old.find(chapter => chapter.id === id);
    return {
      id, title, objectives,
      ...(objectives.length && objectives.every(item => item.doneAt) && previous?.doneAt
        ? { doneAt: previous.doneAt } : {}),
    };
  });
}

export function input(value: unknown): QuestInput {
  object(value);
  valid(typeof value.kind === 'string' &&
    ['main', 'side', 'daily'].includes(value.kind), 'Invalid kind');
  const kind = value.kind as QuestKind;
  const result: QuestInput = {
    kind,
    title: text(value.title, 'title', 200, true),
  };
  if (value.name !== undefined) result.name = text(value.name, 'name', 40);
  if (value.story !== undefined) result.story = text(value.story, 'story', 2000);
  if (value.priority !== undefined) {
    valid(typeof value.priority === 'string' &&
      ['none', 'low', 'medium', 'high'].includes(value.priority), 'Invalid priority');
    result.priority = value.priority as QuestInput['priority'];
  }
  if (value.deadline !== undefined) result.deadline = localDate(value.deadline);
  if (value.scheduledFor !== undefined) result.scheduledFor = localDate(value.scheduledFor);
  if (kind === 'daily') {
    result.recurrence = recurrence(value.recurrence);
    if (value.quota !== undefined) result.quota = countDraft(value.quota);
  } else {
    valid(value.recurrence === undefined && value.quota === undefined,
      'Recurrence and quota are daily-only');
  }
  // Validate structure here; generated ids are assigned only when constructing the stored quest.
  chapters(kind, value.chapters);
  if (value.chapters !== undefined) result.chapters = value.chapters as ChapterDraft[];
  return result;
}

export function patch(quest: StoredQuest, value: unknown): string[] {
  object(value);
  valid(!('kind' in value) && !('chapters' in value), 'Kind is immutable; use set-chapters');
  const keys = ['title', 'name', 'story', 'priority', 'deadline', 'scheduledFor',
    'recurrence', 'quota', 'revealed'] as const;
  const candidate = structuredClone(quest);
  for (const key of keys) {
    if (value[key] === undefined) continue;
    if (value[key] === null) {
      valid(!['title', 'priority', 'revealed'].includes(key), `${key} cannot be cleared`);
      delete candidate[key];
    } else {
      Object.assign(candidate, { [key]: value[key] });
    }
  }
  valid(typeof candidate.revealed === 'boolean', 'Invalid revealed');
  const fields = input({ ...candidate, chapters: quest.kind === 'daily'
    ? undefined : candidate.chapters });
  const normalized = { ...candidate, ...fields };
  const changed = keys.filter(key =>
    JSON.stringify(quest[key]) !== JSON.stringify(normalized[key]));
  for (const key of keys) {
    if (!(key in normalized)) delete quest[key];
    else Object.assign(quest, { [key]: normalized[key] });
  }
  return changed;
}

export function due(quest: StoredQuest, key: string): boolean {
  return quest.recurrence?.freq === 'daily' ||
    (quest.recurrence?.freq === 'weekly' &&
      quest.recurrence.weekdays.includes(new Date(dayTime(key)).getDay()));
}

export function derived(
  quest: StoredQuest, state: State, time: number, hour: number,
): QuestDerived {
  const key = periodKey(time, hour);
  const today = dateKey(time);
  const chapterIndex = quest.chapters.findIndex(chapter => chapter.objectives.some(o => !o.doneAt));
  const chapter = quest.chapters[chapterIndex];
  const objectiveIndex = chapter?.objectives.findIndex(objective => !objective.doneAt) ?? -1;
  const progress = (items: Chapter['objectives']) => items.length
    ? items.reduce((sum, item) => sum + (item.doneAt ? 1 : item.count
      ? Math.min(1, item.count.current / item.count.target) : 0), 0) / items.length
    : quest.status === 'completed' ? 1 : 0;
  let ratio = progress(quest.chapters.flatMap(item => item.objectives));
  let chapterRatio = chapter ? progress(chapter.objectives) : ratio;
  let streak = 0;
  if (quest.kind === 'daily') {
    ratio = quest.quota ? Math.min(1, (quest.cycle?.current ?? 0) / quest.quota.target)
      : quest.cycle?.done ? 1 : 0;
    chapterRatio = ratio;
    const history = new Set(state.history[quest.id] ?? []);
    if (due(quest, key) && quest.cycle?.done) streak++;
    const created = periodKey(new Date(quest.createdAt).getTime(), hour);
    for (let day = previousDay(key); day >= created; day = previousDay(day)) {
      if (!due(quest, day)) continue;
      if (!history.has(day)) break;
      streak++;
    }
  }
  return {
    chapterIndex: chapterIndex < 0 ? quest.chapters.length : chapterIndex,
    objectiveIndex, ratio, chapterRatio, streak,
    dueToday: quest.status !== 'archived' && (quest.kind === 'daily' ? due(quest, key)
      : quest.status === 'active' && Boolean(
        (quest.scheduledFor && quest.scheduledFor <= today) ||
        (quest.deadline && quest.deadline <= today))),
    overdue: quest.status === 'active' && Boolean(quest.deadline && quest.deadline < today),
  };
}
