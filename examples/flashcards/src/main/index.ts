import type {
  EventPayload, Flashcard, FlashcardDeck, FlashcardInput, FlashcardsEvents, FlashcardsRequests,
  FlashcardToday, Json, MainContext, RequestPayload, ResponseData,
} from '@featherlog/contracts';
import { dayStart, fail, gradeReview, identifier, input, object, parseMarkdown, periodKey, text, valid } from './model';
import { loadState, type State } from './storage';

export async function setup(ctx: MainContext): Promise<void> {
  let disposed = false;
  let ready = false;
  let tail = Promise.resolve();
  ctx.onDispose(() => { disposed = true; });
  let state = loadState(await ctx.storage.get('state'), ctx.clock.now());
  if (disposed) return;
  ctx.bus.on('kernel/ready', () => { ready = true; });
  const period = async () => {
    if (ready) {
      try { return await ctx.bus.request('quest/period', {}); }
      catch (cause) {
        // Only an absent quest plugin permits a different day boundary; transient failures must not reset counts.
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'no-handler')) throw cause;
      }
    }
    return { periodKey: periodKey(ctx.clock.now(), 4), dayStartHour: 4 };
  };
  const newLimit = () => {
    const value = ctx.settings.get('newPerDay') ?? 10;
    valid(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100, 'Invalid newPerDay');
    return value;
  };
  const today = (draft: State, end: number): FlashcardToday => ({
    reviewed: draft.today.reviewed,
    remaining: draft.cards.filter(card => card.review.due !== undefined && Date.parse(card.review.due) < end).length +
      Math.min(draft.cards.filter(card => card.review.reviews === 0).length, Math.max(0, newLimit() - draft.today.fresh)),
  });
  const find = (draft: State, value: unknown) => {
    const id = identifier(value);
    return draft.cards.find(card => card.id === id) ?? fail('Card not found', 'flashcards/not-found');
  };
  const create = (fields: FlashcardInput, now: number): Flashcard => ({
    ...input(fields), id: crypto.randomUUID(), review: { box: 0, reviews: 0, lapses: 0 },
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  });
  type Transaction = {
    now: number; key: string; hour: number; end: number;
    emit<K extends keyof FlashcardsEvents>(type: K, payload: EventPayload<K>): void;
  };
  const register = <K extends keyof FlashcardsRequests>(
    type: K, work: (payload: RequestPayload<K>, draft: State, tx: Transaction) => ResponseData<K>,
  ) => ctx.bus.handle(type, (payload, envelope) => {
    // ponytail: serialize and snapshot this small example library; use per-card records if it outgrows one atomic write.
    const job = tail.then(async () => {
      valid(!disposed, 'Flashcards plugin is disposed');
      object(payload);
      const { periodKey: key, dayStartHour: hour } = await period();
      const now = ctx.clock.now();
      const draft = structuredClone(state);
      if (draft.today.periodKey !== key) draft.today = { periodKey: key, reviewed: 0, fresh: 0 };
      const notifications: Array<() => void> = [];
      const result = work(payload, draft, { now, key, hour, end: dayStart(key, 1, hour),
        emit: (type, payload) => { notifications.push(() => ctx.bus.emit(type, payload, { causedBy: envelope.id })); } });
      valid(!disposed, 'Flashcards plugin is disposed');
      if (JSON.stringify(draft) !== JSON.stringify(state)) {
        await ctx.storage.set('state', draft as unknown as Json);
        state = draft;
      }
      if (!disposed) for (const notify of notifications) notify();
      return result;
    });
    tail = job.then(() => {}, () => {});
    return job;
  });
  register('flashcards/create', (payload, draft, tx) => {
    const card = create(payload.input, tx.now);
    draft.cards.push(card);
    tx.emit('flashcards/changed', { card });
    return { card };
  });
  register('flashcards/update', (payload, draft, tx) => {
    const card = find(draft, payload.id);
    object(payload.patch);
    const candidate = { deck: card.deck, question: card.question, answer: card.answer };
    for (const key of ['deck', 'question', 'answer'] as const) {
      if (payload.patch[key] !== undefined) Object.assign(candidate, { [key]: payload.patch[key] });
    }
    const fields = input(candidate);
    if (Object.entries(fields).some(([key, value]) => card[key as keyof Flashcard] !== value)) {
      Object.assign(card, fields, { updatedAt: new Date(tx.now).toISOString() });
      tx.emit('flashcards/changed', { card });
    }
    return { card };
  });
  register('flashcards/delete', (payload, draft, tx) => {
    const card = find(draft, payload.id);
    draft.cards = draft.cards.filter(item => item.id !== card.id);
    tx.emit('flashcards/deleted', { id: card.id });
    return null;
  });
  register('flashcards/import', (payload, draft, tx) => {
    const { inputs, skipped } = parseMarkdown(payload.text, payload.deck, draft.cards);
    draft.cards = draft.cards.concat(inputs.map(fields => create(fields, tx.now)));
    tx.emit('flashcards/imported', { created: inputs.length });
    return { created: inputs.length, skipped };
  });
  register('flashcards/list', (payload, draft, tx) => {
    const deck = payload.deck === undefined ? undefined : text(payload.deck, 'deck', 40, false);
    valid(payload.query === undefined || typeof payload.query === 'string', 'Expected a text query');
    const query = payload.query?.toLowerCase();
    const decks = new Map<string, FlashcardDeck>();
    for (const card of draft.cards) {
      const summary = decks.get(card.deck) ?? { name: card.deck, total: 0, due: 0, fresh: 0 };
      summary.total++;
      if (card.review.reviews === 0) summary.fresh++;
      else if (Date.parse(card.review.due!) < tx.end) summary.due++;
      decks.set(card.deck, summary);
    }
    return { cards: draft.cards.filter(card => (deck === undefined || card.deck === deck) &&
      (query === undefined || card.question.toLowerCase().includes(query) || card.answer.toLowerCase().includes(query)))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    decks: [...decks.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  });
  register('flashcards/next', (payload, draft, tx) => {
    const deck = payload.deck === undefined ? undefined : text(payload.deck, 'deck', 40, false);
    const cards = draft.cards.filter(card => deck === undefined || card.deck === deck);
    let card = cards.filter(card => card.review.due !== undefined && Date.parse(card.review.due) <= tx.now)
      .sort((a, b) => Date.parse(a.review.due!) - Date.parse(b.review.due!))[0];
    if (!card && draft.today.fresh < newLimit()) {
      card = cards.filter(card => card.review.reviews === 0)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
    }
    return { card: card ?? null, today: today(draft, tx.end) };
  });
  register('flashcards/grade', (payload, draft, tx) => {
    const card = find(draft, payload.id);
    valid(payload.grade === 'again' || payload.grade === 'hard' || payload.grade === 'good', 'Invalid grade');
    if (card.review.reviews === 0) draft.today.fresh++;
    card.review = gradeReview(card.review, payload.grade, tx.now, tx.key, tx.hour);
    card.updatedAt = new Date(tx.now).toISOString();
    draft.today.reviewed++;
    const counts = today(draft, tx.end);
    tx.emit('flashcards/reviewed', { card, grade: payload.grade, today: counts });
    return { card, today: counts };
  });
}
