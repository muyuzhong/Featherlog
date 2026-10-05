import { describe, expect, it } from 'vitest';
import { BUILTIN, DRAFT_PROMPT, EPILOGUE_PROMPT, epilogueTitle, PERSONA, prose, questDraft, SPLIT_PROMPT, splitDraft, validDate } from './writing';

const main = { kind: 'main', title: '  学习  ', chapters: [{ title: '开卷', objectives: [{ text: '动手', count: { target: 3, unit: '页' } }] }] };
const daily = { kind: 'daily', title: '练习', recurrence: { freq: 'daily' } };

describe('§8.2 drafts at the model trust boundary', () => {
  it('accepts all three kinds and strips generated ids and progress', () => {
    expect(questDraft(main)).toMatchObject({ title: '学习', chapters: [{ title: '开卷' }] });
    expect(questDraft({ kind: 'side', title: '小事', chapters: [] })).toEqual({ kind: 'side', title: '小事', chapters: [] });
    expect(questDraft({ ...daily, priority: 'high', name: '晨课', story: '开卷', quota: { target: 2 },
      deadline: '2028-02-29', scheduledFor: '2026-10-04' })).toMatchObject({ quota: { target: 2 }, recurrence: { freq: 'daily' } });
    expect(questDraft({ ...daily, recurrence: { freq: 'weekly', weekdays: [0, 6] } })).toMatchObject({ recurrence: { weekdays: [0, 6] } });
    expect(splitDraft([{ id: 'existing', text: '一', doneAt: 'yesterday', count: { target: 2, current: 1 } },
      { text: '二', detail: '细节' }])).toEqual([{ text: '一', count: { target: 2 } }, { text: '二', detail: '细节' }]);
  });
  const bad: unknown[] = [null, [], {}, { kind: 'alien', title: 'x' }, { kind: 'side', title: ' ' },
    { kind: 'side', title: 'x'.repeat(201) }, { kind: 'side', title: 1 },
    { ...main, name: 'x'.repeat(41) }, { ...main, story: 'x'.repeat(2001) }, { ...main, priority: 'urgent' },
    { ...main, chapters: [] }, { ...main, chapters: null }, { ...main, chapters: [{ title: '', objectives: [] }] },
    { ...main, chapters: [{ title: 1, objectives: [] }] }, { ...main, chapters: [{ title: '', objectives: null }] },
    { ...main, chapters: [{ title: '', objectives: [{ text: '' }] }] },
    { ...main, chapters: [{ title: '', objectives: [{ text: 'x', count: { target: 0 } }] }] },
    { ...main, chapters: [{ title: '', objectives: [{ text: 'x', count: { target: 1.5 } }] }] },
    { ...main, chapters: [{ title: '', objectives: [{ text: 'x', count: { target: Number.MAX_SAFE_INTEGER + 1 } }] }] },
    { kind: 'side', title: 'x', chapters: main.chapters }, { kind: 'side', title: 'x', chapters: [{ title: 'named', objectives: [] }] },
    { ...daily, chapters: [] }, { ...daily, recurrence: undefined }, { ...daily, recurrence: { freq: 'monthly' } },
    { ...daily, recurrence: { freq: 'weekly', weekdays: [] } }, { ...daily, recurrence: { freq: 'weekly', weekdays: [1, 1] } },
    ...[-1, 7, 1.5, '1'].map(day => ({ ...daily, recurrence: { freq: 'weekly', weekdays: [day] } })),
    { kind: 'side', title: 'x', recurrence: { freq: 'daily' } }, { kind: 'side', title: 'x', quota: { target: 1 } },
    { ...daily, quota: { target: -1 } }, { ...daily, quota: { target: 1.5 } }, { ...daily, quota: { target: 1, unit: 0 } },
    ...['2026-02-29', '2026-13-01', '2026-10-00', '2026-1-01'].map(deadline => ({ ...main, deadline })),
  ];
  it.each(bad.map((value, index) => [index, value] as const))('rejects invalid draft %i', (_, value) => {
    expect(() => questDraft(value)).toThrow(expect.objectContaining({ code: 'scribe/unusable-reply' }));
  });
  it.each([null, [], [{ text: 'one' }], Array.from({ length: 5 }, () => ({ text: 'step' })), [{ text: '' }, { text: 'two' }]])
    ('rejects invalid split %j', value => { expect(() => splitDraft(value)).toThrow(); });
  it('uses the same calendar validation for request dates', () => {
    expect(validDate('2028-02-29')).toBe('2028-02-29');
    expect(() => validDate('2026-02-29')).toThrow();
  });
});

describe('fixed persona and offline review samples', () => {
  it('keeps writing rules fixed and includes JSON schemas and examples', () => {
    expect(PERSONA).toMatchSnapshot();
    expect(DRAFT_PROMPT).toContain('示例'); expect(SPLIT_PROMPT).toContain('2–4');
    for (const lines of Object.values(BUILTIN)) {
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) expect(prose(line, {}, 40, true)).toBe(line);
    }
  });
  it.each(['No Chinese', '你又没坚持。', '应该羞愧。', '甲。乙。', '换\n行', '字'.repeat(41), '完成了99次。', '《不存在》完结。'])
    ('rejects unsafe reaction %s', value => { expect(() => prose(value, { title: '练习', count: 3 }, 40, true)).toThrow(); });
  it('allows only provided task names, dates and counts', () => {
    expect(prose('《练习》记了3次。', { title: '练习', count: 3 }, 40, true)).toBe('《练习》记了3次。');
    expect(prose('2026-10-03这页已记。', { date: '2026-10-03' }, 40, true)).toContain('2026-10-03');
  });
});


describe('§16 attributes and optional epilogue titles', () => {
  it.each([main, daily, { kind: 'side', title: '整理' }])('keeps valid attributes on $kind drafts and omits empty arrays', input => {
    expect(questDraft({ ...input, attributes: ['learning', 'craft'] }).attributes).toEqual(['learning', 'craft']);
    expect(questDraft({ ...input, attributes: ['body', 'mind'] }).attributes).toEqual(['body', 'mind']);
    expect(questDraft({ ...input, attributes: [] })).not.toHaveProperty('attributes');
    expect(questDraft(input)).not.toHaveProperty('attributes');
  });
  it.each([null, 'learning', {}, [null], [1], ['other'], ['mind', 'mind'], ['mind', 'body', 'craft']])(
    'rejects invalid draft attributes %j', attributes => {
      expect(() => questDraft({ ...main, attributes })).toThrow(expect.objectContaining({ code: 'scribe/unusable-reply' }));
    },
  );
  it('explains all four attributes and the main epilogue title shape in prompts', () => {
    for (const attribute of ['learning', 'body', 'mind', 'craft']) expect(DRAFT_PROMPT).toContain(attribute);
    expect(DRAFT_PROMPT).toContain('一到两项不重复');
    expect(EPILOGUE_PROMPT).toContain('至多8字、不带标点');
    expect(EPILOGUE_PROMPT).toContain('"text":string,"title"?:string');
  });
  it.each([undefined, null, false, 8, {}, [], '', '   ', '一二三四五六七八九', '三卷，读罢', '三卷。',
    '三卷!', '「三卷」', '三卷—读罢', '三 卷', '三\n卷', '三卷🪶', '\u0000三卷'])('drops unusable title %j without throwing', title => {
    expect(epilogueTitle(title)).toBeUndefined();
  });
  it.each(['三卷读罢', '一二三四五六七八', '𠀀'.repeat(8), '读书8卷'])('accepts at most eight Unicode characters: %s', title => {
    expect(epilogueTitle(`  ${title}  `)).toBe(title);
  });
});
