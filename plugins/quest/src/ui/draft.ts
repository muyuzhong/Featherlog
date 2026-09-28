import type { ChapterDraft, ObjectiveDraft, Quest, QuestInput, QuestKind, QuestPatch, Recurrence } from '@featherlog/contracts';

/*
 * The editor's working copy of a quest. Numbers stay strings while being typed;
 * everything is checked against design §8.2 before anything is sent, so the
 * plugin's own "quest/invalid-input" is a backstop, not the first line.
 */

export type ObjectiveRow = {
  /** React key; stable across edits. */
  key: string;
  /** Present for objectives that already exist: their progress is kept (quest/set-chapters). */
  id?: string;
  text: string;
  detail?: string;
  counted: boolean;
  target: string;
  unit: string;
  done: boolean;
};

export type ChapterRow = { key: string; id?: string; title: string; objectives: ObjectiveRow[]; done: boolean };

export type Draft = {
  kind: QuestKind;
  title: string;
  name: string;
  story: string;
  /** main: every chapter. side: exactly one, untitled. daily: empty. */
  chapters: ChapterRow[];
  deadline: string;
  repeat: 'daily' | 'weekly';
  weekdays: number[];
  quotaOn: boolean;
  quotaTarget: string;
  quotaUnit: string;
};

export const LIMITS = { title: 200, name: 40, story: 2000 };

let serial = 0;
export const rowKey = () => `row-${++serial}`;

export const blankObjective = (): ObjectiveRow => ({ key: rowKey(), text: '', counted: false, target: '', unit: '', done: false });
export const blankChapter = (): ChapterRow => ({ key: rowKey(), title: '', objectives: [blankObjective()], done: false });

export function blankDraft(kind: QuestKind): Draft {
  return {
    kind,
    title: '',
    name: '',
    story: '',
    chapters: kind === 'daily' ? [] : [blankChapter()],
    deadline: '',
    repeat: 'daily',
    weekdays: [1, 2, 3, 4, 5],
    quotaOn: false,
    quotaTarget: '',
    quotaUnit: '',
  };
}

/** Switching kind while creating keeps what was written, reshaped for the new kind. */
export function withKind(draft: Draft, kind: QuestKind): Draft {
  if (kind === draft.kind) return draft;
  const objectives = draft.chapters.flatMap((c) => c.objectives);
  const chapters =
    kind === 'daily'
      ? []
      : kind === 'side'
        ? [{ ...(draft.chapters[0] ?? blankChapter()), title: '', objectives: objectives.length ? objectives : [blankObjective()] }]
        : draft.chapters.length
          ? draft.chapters
          : [blankChapter()];
  return { ...draft, kind, chapters };
}

export function draftFromQuest(quest: Quest): Draft {
  const recurrence = quest.recurrence;
  return {
    ...blankDraft(quest.kind),
    title: quest.title,
    name: quest.name ?? '',
    story: quest.story ?? '',
    chapters: quest.chapters.map((chapter) => ({
      key: rowKey(),
      id: chapter.id,
      title: chapter.title,
      done: chapter.doneAt !== undefined,
      objectives: chapter.objectives.map((o) => ({
        key: rowKey(),
        id: o.id,
        text: o.text,
        ...(o.detail !== undefined ? { detail: o.detail } : {}),
        counted: o.count !== undefined,
        target: o.count ? String(o.count.target) : '',
        unit: o.count?.unit ?? '',
        done: o.doneAt !== undefined,
      })),
    })),
    deadline: quest.deadline ?? '',
    repeat: recurrence?.freq ?? 'daily',
    weekdays: recurrence?.freq === 'weekly' ? [...recurrence.weekdays] : [1, 2, 3, 4, 5],
    quotaOn: quest.quota !== undefined,
    quotaTarget: quest.quota ? String(quest.quota.target) : '',
    quotaUnit: quest.quota?.unit ?? '',
  };
}

export type Problem = { field: string; message: string };

const positiveInteger = (value: string) => /^\s*\d+\s*$/.test(value) && Number(value) > 0;

/** Rows left blank are ignored, like unused lines on a page. */
const writtenObjectives = (chapter: ChapterRow) => chapter.objectives.filter((o) => o.text.trim() !== '');

/** The first thing that stops this draft from being saved, if any. */
export function problem(draft: Draft): Problem | null {
  if (!draft.title.trim()) return { field: 'title', message: '先写下真实目标：要在现实里做成的事' };
  if (draft.title.trim().length > LIMITS.title) return { field: 'title', message: `真实目标最多${LIMITS.title}字` };
  if (draft.name.trim().length > LIMITS.name) return { field: 'name', message: `任务名最多${LIMITS.name}字` };
  if (draft.story.trim().length > LIMITS.story) return { field: 'story', message: `简报最多${LIMITS.story}字` };

  if (draft.kind === 'main') {
    if (!draft.chapters.length) return { field: 'chapters', message: '主线至少要有一章' };
    const empty = draft.chapters.findIndex((c) => writtenObjectives(c).length === 0);
    if (empty >= 0) return { field: `chapter:${draft.chapters[empty]!.key}`, message: '每一章至少写一个目标' };
  }
  for (const chapter of draft.chapters) {
    for (const o of writtenObjectives(chapter)) {
      if (o.counted && !positiveInteger(o.target)) return { field: `objective:${o.key}`, message: '计数的目标要写一个正整数' };
    }
  }
  if (draft.kind === 'daily') {
    if (draft.repeat === 'weekly' && !draft.weekdays.length) return { field: 'weekdays', message: '每周至少选一天' };
    if (draft.quotaOn && !positiveInteger(draft.quotaTarget)) return { field: 'quota', message: '配额要写一个正整数' };
  }
  if (draft.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(draft.deadline)) return { field: 'deadline', message: '限期的日期不对' };
  return null;
}

const optional = (value: string) => {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

function objectiveDraft(o: ObjectiveRow): ObjectiveDraft {
  const unit = optional(o.unit);
  return {
    ...(o.id ? { id: o.id } : {}),
    text: o.text.trim(),
    ...(o.detail !== undefined ? { detail: o.detail } : {}),
    ...(o.counted ? { count: { target: Number(o.target), ...(unit ? { unit } : {}) } } : {}),
  };
}

export function chapterDrafts(draft: Draft): ChapterDraft[] {
  return draft.chapters.map((c) => ({
    ...(c.id ? { id: c.id } : {}),
    title: draft.kind === 'side' ? '' : c.title.trim(),
    objectives: writtenObjectives(c).map(objectiveDraft),
  }));
}

function recurrence(draft: Draft): Recurrence {
  const weekdays = [...new Set(draft.weekdays)].sort((a, b) => a - b);
  return draft.repeat === 'weekly' ? { freq: 'weekly', weekdays } : { freq: 'daily' };
}

function quota(draft: Draft): { target: number; unit?: string } | undefined {
  if (!draft.quotaOn) return undefined;
  const unit = optional(draft.quotaUnit);
  return { target: Number(draft.quotaTarget), ...(unit ? { unit } : {}) };
}

/** A valid draft as "quest/create" input. */
export function toInput(draft: Draft): QuestInput {
  const name = optional(draft.name);
  const story = optional(draft.story);
  const q = quota(draft);
  return {
    kind: draft.kind,
    title: draft.title.trim(),
    ...(name ? { name } : {}),
    ...(story ? { story } : {}),
    ...(draft.kind !== 'daily' ? { chapters: chapterDrafts(draft) } : {}),
    ...(draft.kind !== 'daily' && draft.deadline ? { deadline: draft.deadline } : {}),
    ...(draft.kind === 'daily' ? { recurrence: recurrence(draft), ...(q ? { quota: q } : {}) } : {}),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A valid draft of an existing quest as the requests that save it: a patch of
 * the fields that changed ("quest/update", null clears) and, if the structure
 * changed, the new chapters ("quest/set-chapters"). Either may be absent.
 */
export function toEdit(quest: Quest, draft: Draft): { patch?: QuestPatch; chapters?: ChapterDraft[] } {
  const patch: QuestPatch = {};
  const title = draft.title.trim();
  if (title !== quest.title) patch.title = title;
  const name = optional(draft.name);
  if (name !== quest.name) patch.name = name ?? null;
  const story = optional(draft.story);
  if (story !== quest.story) patch.story = story ?? null;
  if (quest.kind === 'daily') {
    const r = recurrence(draft);
    if (!same(r, quest.recurrence)) patch.recurrence = r;
    const q = quota(draft);
    if (!same(q, quest.quota)) patch.quota = q ?? null;
  } else {
    const deadline = optional(draft.deadline);
    if (deadline !== quest.deadline) patch.deadline = deadline ?? null;
  }

  const chapters = quest.kind === 'daily' ? undefined : chapterDrafts(draft);
  const before = quest.chapters.map((c) => ({
    id: c.id,
    title: c.title,
    objectives: c.objectives.map((o) => ({
      id: o.id,
      text: o.text,
      ...(o.detail !== undefined ? { detail: o.detail } : {}),
      ...(o.count ? { count: { target: o.count.target, ...(o.count.unit !== undefined ? { unit: o.count.unit } : {}) } } : {}),
    })),
  }));
  return {
    ...(Object.keys(patch).length ? { patch } : {}),
    ...(chapters && !same(chapters, before) ? { chapters } : {}),
  };
}
