import type {
  Flashcard, FlashcardGrade, FlashcardInput, FlashcardReview, FlashcardsErrorCode,
} from '@featherlog/contracts';

export function fail(message: string, code: FlashcardsErrorCode = 'flashcards/invalid-input'): never {
  throw Object.assign(new Error(message), { code });
}
export function valid(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}
export function object(value: unknown): asserts value is Record<string, unknown> {
  valid(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
}
export function text(value: unknown, label: string, max: number, required = true): string {
  valid(typeof value === 'string', `${label} must be text`);
  const result = value.trim();
  valid(result.length <= max && (!required || result.length > 0), `Invalid ${label} length`);
  return result;
}
export function input(value: unknown): Required<FlashcardInput> {
  object(value);
  return { deck: value.deck === undefined ? '' : text(value.deck, 'deck', 40, false),
    question: text(value.question, 'question', 500), answer: text(value.answer, 'answer', 10000) };
}
export function identifier(value: unknown): string {
  return text(value, 'id', Infinity);
}
export function dateKey(time: number): string {
  const date = new Date(time);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function periodKey(time: number, hour: number): string {
  return dateKey(time - hour * 3_600_000);
}
export function dayStart(key: string, days: number, hour: number): number {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(0);
  date.setFullYear(year, month - 1, day + days);
  date.setHours(0, 0, 0, 0);
  // Match quest's elapsed-hour shift, including daylight-saving transitions.
  return date.getTime() + hour * 3_600_000;
}
export function gradeReview(
  previous: FlashcardReview, grade: FlashcardGrade, now: number, key: string, hour: number,
): FlashcardReview {
  const box = grade === 'again' ? 0 : grade === 'good' ? Math.min(7, previous.box + 1)
    : previous.reviews === 0 ? 1 : previous.box;
  const days = [0, 1, 2, 4, 7, 15, 30, 60][box]!;
  return { box, reviews: previous.reviews + 1,
    lapses: previous.lapses + (grade === 'again' && previous.box >= 1 ? 1 : 0),
    lastGrade: grade, lastReviewedAt: new Date(now).toISOString(),
    due: new Date(box === 0 ? now + 600_000 : dayStart(key, days, hour)).toISOString() };
}

export function parseMarkdown(value: unknown, defaultDeck: unknown, existing: Flashcard[]) {
  valid(typeof value === 'string' && new TextEncoder().encode(value).byteLength <= 1_048_576,
    'Markdown must be at most 1 MB of UTF-8 text');
  let deck = defaultDeck === undefined ? '' : text(defaultDeck, 'deck', 40, false);
  const inputs: Required<FlashcardInput>[] = [];
  const known = new Set(existing.map(card => JSON.stringify([card.deck, card.question])));
  let question: string | undefined;
  let answer: string[] = [];
  let fence = 0;
  let skipped = 0;
  const finish = () => {
    if (question === undefined) return;
    let candidate: Required<FlashcardInput>;
    try { candidate = input({ deck, question, answer: answer.join('\n') }); }
    catch { skipped++; return; }
    const key = JSON.stringify([candidate.deck, candidate.question]);
    if (known.has(key)) { skipped++; return; }
    known.add(key);
    inputs.push(candidate);
  };
  for (const line of value.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,})([^`]*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]!.length >= fence && !marker[2]!.trim()) fence = 0;
    } else if (marker) fence = marker[1]!.length;
    else {
      const heading = /^ {0,3}(#{1,3})[ \t]+(.*)$/.exec(line);
      if (heading) {
        finish(); question = undefined; answer = [];
        if (heading[1] === '#') deck = heading[2]!.trim();
        else question = heading[2]!.trim();
        continue;
      }
    }
    if (question !== undefined) answer.push(line);
  }
  finish();
  return { inputs, skipped };
}
