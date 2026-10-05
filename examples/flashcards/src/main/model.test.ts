import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Flashcard, FlashcardGrade, FlashcardReview } from '@featherlog/contracts';
import { gradeReview, input, parseMarkdown, periodKey } from './model';

const now = new Date('2026-10-05T12:00:00').getTime();
afterEach(() => vi.unstubAllEnvs());
const existing = (deck: string, question: string): Flashcard => ({
  id: 'existing', deck, question, answer: 'kept', review: { box: 0, reviews: 0, lapses: 0 },
  createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
});

describe('§17.3 Markdown import', () => {
  it('honors heading levels, default decks, deep headings, line breaks and fenced code', () => {
    const source = [
      'Preamble ignored', '##  Before deck  ', '  Answer  ', '# Redis', '## RDB?', 'Snapshot',
      '#### Detail', '```typescript', '# not a deck', '## not a question', '```', 'tail',
      '### AOF?', 'Log', '# Linux', '## proc?', 'Virtual files',
    ].join('\r\n');
    expect(parseMarkdown(source, '  File name  ', [])).toEqual({ skipped: 0, inputs: [
      { deck: 'File name', question: 'Before deck', answer: 'Answer' },
      { deck: 'Redis', question: 'RDB?', answer: 'Snapshot\n#### Detail\n```typescript\n# not a deck\n## not a question\n```\ntail' },
      { deck: 'Redis', question: 'AOF?', answer: 'Log' },
      { deck: 'Linux', question: 'proc?', answer: 'Virtual files' },
    ] });
    expect(parseMarkdown('## No deck\nAnswer', undefined, []).inputs[0]!.deck).toBe('');
  });

  it('does not read headings from preamble fences or shorter nested fences', () => {
    expect(parseMarkdown('```md\n## fake\nanswer\n```\n## real\n````md\n```\n# code\n````\nend', '', []))
      .toEqual({ skipped: 0, inputs: [{ deck: '', question: 'real', answer: '````md\n```\n# code\n````\nend' }] });
    expect(parseMarkdown('## real\n```\n# unclosed code', '', []).inputs[0]!.answer).toBe('```\n# unclosed code');
  });

  it('skips empty, duplicate and overlong cards while keeping valid ones', () => {
    const source = [
      '##  RDB?  ', 'duplicate existing', '## Empty', '  ',
      '## New', 'Answer', '### New', 'duplicate within import',
      `## ${'q'.repeat(501)}`, 'Answer', '## Long answer', 'a'.repeat(10001),
      `# ${'d'.repeat(41)}`, '## Long deck', 'Answer',
      '# Other', '## RDB?', 'different deck', '## Valid', 'Last answer',
    ].join('\n');
    expect(parseMarkdown(source, 'Redis', [existing('Redis', 'RDB?')])).toEqual({ skipped: 6, inputs: [
      { deck: 'Redis', question: 'New', answer: 'Answer' },
      { deck: 'Other', question: 'RDB?', answer: 'different deck' },
      { deck: 'Other', question: 'Valid', answer: 'Last answer' },
    ] });
  });

  it('accepts exactly 1 MiB UTF-8 bytes and refuses larger multibyte text', () => {
    expect(parseMarkdown('x'.repeat(1_048_576), undefined, [])).toEqual({ inputs: [], skipped: 0 });
    expect(parseMarkdown('羽'.repeat(349_525) + 'a', undefined, [])).toEqual({ inputs: [], skipped: 0 });
    for (const value of ['x'.repeat(1_048_577), '羽'.repeat(349_526), null, 1]) {
      expect(() => parseMarkdown(value, undefined, [])).toThrow(expect.objectContaining({ code: 'flashcards/invalid-input' }));
    }
  });

  it('trims plain text at inclusive limits and rejects invalid direct input', () => {
    expect(input({ deck: 'd'.repeat(40), question: `  ${'q'.repeat(500)}  `, answer: 'a'.repeat(10000) }))
      .toEqual({ deck: 'd'.repeat(40), question: 'q'.repeat(500), answer: 'a'.repeat(10000) });
    expect(input({ question: ' q\nline ', answer: ' answer\nline ' })).toEqual({ deck: '', question: 'q\nline', answer: 'answer\nline' });
    for (const value of [null, {}, { question: ' ', answer: 'a' }, { question: 'q', answer: '' },
      { question: 'q', answer: 'a', deck: null }, { question: 1, answer: 'a' },
      { question: 'q'.repeat(501), answer: 'a' }, { question: 'q', answer: 'a'.repeat(10001) },
      { question: 'q', answer: 'a', deck: 'd'.repeat(41) }]) {
      expect(() => input(value)).toThrow(expect.objectContaining({ code: 'flashcards/invalid-input' }));
    }
  });
});

describe('§17.4 review boxes', () => {
  const intervals = [0, 1, 2, 4, 7, 15, 30, 60];
  const cases = Array.from({ length: 8 }, (_, box) => (['again', 'hard', 'good'] as FlashcardGrade[])
    .map(grade => [box, grade] as const)).flat();
  it.each(cases)('grades reviewed box %i with %s', (box, grade) => {
    const previous: FlashcardReview = { box, reviews: 10, lapses: 2 };
    const result = gradeReview(previous, grade, now, '2026-10-05', 4);
    const next = grade === 'again' ? 0 : grade === 'hard' ? box : Math.min(7, box + 1);
    const date = new Date('2026-10-05T04:00:00'); date.setDate(date.getDate() + intervals[next]!);
    expect(result).toEqual({ box: next, reviews: 11, lapses: 2 + (grade === 'again' && box > 0 ? 1 : 0),
      lastGrade: grade, lastReviewedAt: new Date(now).toISOString(),
      due: new Date(next === 0 ? now + 600_000 : date.getTime()).toISOString() });
    expect(previous).toEqual({ box, reviews: 10, lapses: 2 });
  });

  it.each(['again', 'hard', 'good'] as const)('grades a new card with %s', grade => {
    const result = gradeReview({ box: 0, reviews: 0, lapses: 0 }, grade, now, '2026-10-05', 4);
    expect(result.box).toBe(grade === 'again' ? 0 : 1);
    expect(result.lapses).toBe(0);
    expect(result.due).toBe(new Date(grade === 'again' ? now + 600_000 : new Date('2026-10-06T04:00:00').getTime()).toISOString());
  });

  it.each([0, 4, 23])('anchors a day interval to the logical period at boundary hour %i', hour => {
    const boundary = new Date('2026-10-05T00:00:00').getTime() + hour * 3_600_000;
    const previous = { box: 0, reviews: 0, lapses: 0 };
    expect(periodKey(boundary - 1, hour)).toBe('2026-10-04');
    expect(gradeReview(previous, 'good', boundary - 1, periodKey(boundary - 1, hour), hour).due)
      .toBe(new Date(boundary).toISOString());
    expect(periodKey(boundary, hour)).toBe('2026-10-05');
    expect(gradeReview(previous, 'good', boundary, periodKey(boundary, hour), hour).due)
      .toBe(new Date(boundary + 86_400_000).toISOString());
  });

  it('uses the same elapsed-hour day boundary as quest across daylight-saving changes', () => {
    vi.stubEnv('TZ', 'America/New_York');
    for (const [key, expected] of [['2026-03-07', '2026-03-08T05:00:00'], ['2026-10-31', '2026-11-01T03:00:00']]) {
      const time = new Date(`${key}T12:00:00`).getTime();
      const result = gradeReview({ box: 0, reviews: 0, lapses: 0 }, 'good', time, key!, 4);
      expect(result.due).toBe(new Date(expected!).toISOString());
      expect(periodKey(Date.parse(result.due!), 4)).toBe(expected!.slice(0, 10));
    }
  });
});
