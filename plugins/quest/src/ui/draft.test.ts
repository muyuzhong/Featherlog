import type { Quest } from '@featherlog/contracts';
import { describe, expect, it } from 'vitest';
import { blankDraft, blankObjective, draftFromQuest, problem, toEdit, toInput, withKind, type Draft } from './draft';

const derived = { chapterIndex: 0, objectiveIndex: 0, ratio: 0, chapterRatio: 0, streak: 0, dueToday: false, overdue: false };

function quest(overrides: Partial<Quest> = {}): Quest {
  return {
    id: 'q1',
    kind: 'main',
    title: '背完 Redis 八股',
    name: '内存之王',
    status: 'active',
    priority: 'none',
    tracked: false,
    revealed: false,
    chapters: [
      {
        id: 'c1',
        title: '数据结构',
        doneAt: '2026-09-20T10:00:00.000Z',
        objectives: [{ id: 'o1', text: '跳表', doneAt: '2026-09-20T10:00:00.000Z' }],
      },
      {
        id: 'c2',
        title: '持久化',
        objectives: [
          { id: 'o2', text: '背卡片', count: { current: 12, target: 30, unit: '张' } },
          { id: 'o3', text: '写笔记', detail: '两百字' },
        ],
      },
    ],
    order: 0,
    createdAt: '2026-09-20T09:00:00.000Z',
    updatedAt: '2026-09-20T09:00:00.000Z',
    derived,
    ...overrides,
  };
}

const write = (draft: Draft, patch: Partial<Draft>): Draft => ({ ...draft, ...patch });

describe('problem (design §8.2)', () => {
  it('requires a real goal, trimmed, and bounds every text field', () => {
    expect(problem(blankDraft('side'))?.field).toBe('title');
    expect(problem(write(blankDraft('side'), { title: '   ' }))?.field).toBe('title');
    expect(problem(write(blankDraft('side'), { title: 'x'.repeat(201) }))?.field).toBe('title');
    expect(problem(write(blankDraft('side'), { title: 'x'.repeat(200) }))).toBeNull();
    expect(problem(write(blankDraft('side'), { title: '修 bug', name: 'x'.repeat(41) }))?.field).toBe('name');
    expect(problem(write(blankDraft('side'), { title: '修 bug', story: 'x'.repeat(2001) }))?.field).toBe('story');
  });

  it('lets a side quest have no objectives, but every main chapter needs one', () => {
    expect(problem(write(blankDraft('side'), { title: '交房租' }))).toBeNull();
    const main = write(blankDraft('main'), { title: '学 Redis' });
    expect(problem(main)?.field).toBe(`chapter:${main.chapters[0]!.key}`);
    main.chapters[0]!.objectives[0]!.text = '跳表';
    expect(problem(main)).toBeNull();
    expect(problem(write(main, { chapters: [] }))?.field).toBe('chapters');
  });

  it('needs a positive integer for a counted objective and a quota', () => {
    const draft = write(blankDraft('side'), { title: '背卡片' });
    const objective = draft.chapters[0]!.objectives[0]!;
    Object.assign(objective, { text: '背卡片', counted: true, target: '0' });
    expect(problem(draft)?.field).toBe(`objective:${objective.key}`);
    objective.target = '2.5';
    expect(problem(draft)).not.toBeNull();
    objective.target = '30';
    expect(problem(draft)).toBeNull();

    const daily = write(blankDraft('daily'), { title: '背卡片', quotaOn: true, quotaTarget: '' });
    expect(problem(daily)?.field).toBe('quota');
    expect(problem(write(daily, { quotaTarget: '10' }))).toBeNull();
  });

  it('needs at least one weekday for a weekly daily', () => {
    const daily = write(blankDraft('daily'), { title: '跑步', repeat: 'weekly', weekdays: [] });
    expect(problem(daily)?.field).toBe('weekdays');
    expect(problem(write(daily, { weekdays: [0] }))).toBeNull();
  });
});

describe('toInput', () => {
  it('drops blank rows and optional fields, and trims', () => {
    const draft = write(blankDraft('main'), { title: ' 学 Redis ', name: '  ', story: '', deadline: '2026-10-31' });
    draft.chapters[0]!.title = ' 数据结构 ';
    draft.chapters[0]!.objectives = [
      { ...blankObjective(), text: '跳表' },
      blankObjective(),
      { ...blankObjective(), text: '背卡片', counted: true, target: '30', unit: '张' },
    ];
    expect(toInput(draft)).toEqual({
      kind: 'main',
      title: '学 Redis',
      chapters: [{ title: '数据结构', objectives: [{ text: '跳表' }, { text: '背卡片', count: { target: 30, unit: '张' } }] }],
      deadline: '2026-10-31',
    });
  });

  it('writes a side quest as one untitled chapter', () => {
    const draft = withKind(write(blankDraft('main'), { title: '修 bug' }), 'side');
    draft.chapters[0]!.title = 'ignored';
    expect(toInput(draft)).toEqual({ kind: 'side', title: '修 bug', chapters: [{ title: '', objectives: [] }] });
  });

  it('gives a daily its recurrence and quota but no chapters or deadline', () => {
    const draft = write(blankDraft('daily'), {
      title: '背卡片',
      deadline: '2026-10-01',
      repeat: 'weekly',
      weekdays: [5, 1, 1, 3],
      quotaOn: true,
      quotaTarget: '10',
      quotaUnit: '张',
    });
    expect(toInput(draft)).toEqual({
      kind: 'daily',
      title: '背卡片',
      recurrence: { freq: 'weekly', weekdays: [1, 3, 5] },
      quota: { target: 10, unit: '张' },
    });
  });
});

describe('withKind', () => {
  it('keeps what was written when switching kinds before creating', () => {
    const main = write(blankDraft('main'), { title: '学 Redis' });
    main.chapters[0]!.objectives[0]!.text = '跳表';
    main.chapters.push({ ...main.chapters[0]!, key: 'second', objectives: [{ ...blankObjective(), text: '持久化' }] });
    const side = withKind(main, 'side');
    expect(side.chapters).toHaveLength(1);
    expect(side.chapters[0]!.objectives.map((o) => o.text)).toEqual(['跳表', '持久化']);
    expect(withKind(side, 'daily').chapters).toEqual([]);
    expect(withKind(withKind(side, 'daily'), 'main').chapters).toHaveLength(1);
    expect(side.title).toBe('学 Redis');
  });
});

describe('toEdit', () => {
  it('sends nothing when nothing changed', () => {
    const q = quest({ deadline: '2026-10-31', story: '简报' });
    expect(toEdit(q, draftFromQuest(q))).toEqual({});
  });

  it('patches changed fields and clears emptied ones with null', () => {
    const q = quest({ deadline: '2026-10-31', story: '简报' });
    const draft = write(draftFromQuest(q), { title: '背完 Redis', name: '', story: '', deadline: '' });
    expect(toEdit(q, draft)).toEqual({ patch: { title: '背完 Redis', name: null, story: null, deadline: null } });
  });

  it('keeps ids (and so progress) of existing chapters and objectives when the structure changes', () => {
    const q = quest();
    const draft = draftFromQuest(q);
    draft.chapters[1]!.objectives.push({ ...blankObjective(), text: '对比 RDB 与 AOF' });
    expect(toEdit(q, draft)).toEqual({
      chapters: [
        { id: 'c1', title: '数据结构', objectives: [{ id: 'o1', text: '跳表' }] },
        {
          id: 'c2',
          title: '持久化',
          objectives: [
            { id: 'o2', text: '背卡片', count: { target: 30, unit: '张' } },
            { id: 'o3', text: '写笔记', detail: '两百字' },
            { text: '对比 RDB 与 AOF' },
          ],
        },
      ],
    });
  });

  it("edits a daily's recurrence and quota", () => {
    const q = quest({ kind: 'daily', chapters: [], title: '背卡片', recurrence: { freq: 'daily' }, quota: { target: 10, unit: '张' } });
    const draft = draftFromQuest(q);
    expect(draft.quotaOn).toBe(true);
    expect(toEdit(q, draft)).toEqual({});
    expect(toEdit(q, write(draft, { repeat: 'weekly', weekdays: [6, 0], quotaOn: false }))).toEqual({
      patch: { recurrence: { freq: 'weekly', weekdays: [0, 6] }, quota: null },
    });
  });
});
