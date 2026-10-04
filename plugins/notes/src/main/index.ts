import type {
  Envelope, Json, MainContext, Note, NotesErrorCode, NotesRequests, RequestPayload, ResponseData,
} from '@featherlog/contracts';

const prefix = 'note:';
function fail(message: string, code: NotesErrorCode = 'notes/invalid-input'): never {
  throw Object.assign(new Error(message), { code });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) fail('Expected a nonempty id');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 20_000) {
    fail('Note text must contain 1 to 20000 characters');
  }
  return value.trim();
}
function instant(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    fail('Expected an ISO timestamp with a time zone');
  }
  const time = Date.parse(value);
  const day = value.slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(time) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    fail('Invalid timestamp');
  }
  return time;
}
function record(value: unknown, key: string): Note {
  const stored = object(value);
  if (stored.schemaVersion !== 1) fail('Unsupported notes schemaVersion');
  const note = object(stored.note);
  const id = identifier(note.id);
  if (key !== `${prefix}${id}`) fail('Stored note id does not match its key');
  text(note.text);
  instant(note.createdAt); instant(note.updatedAt);
  return { id, text: note.text as string, createdAt: note.createdAt as string, updatedAt: note.updatedAt as string,
    ...(note.questId === undefined ? {} : { questId: identifier(note.questId) }) };
}

export async function setup(ctx: MainContext): Promise<void> {
  let disposed = false;
  let tail = Promise.resolve();
  let lastCreated = -Infinity;
  const guard = () => { if (disposed) fail('Notes plugin is disposed'); };
  // ponytail: serialize the notebook; use per-note queues if write throughput becomes significant.
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const job = tail.then(() => { guard(); return work(); });
    tail = job.then(() => {}, () => {});
    return job;
  };
  ctx.onDispose(() => { disposed = true; });
  const get = async (id: string): Promise<Note> => {
    const key = `${prefix}${id}`;
    const value = await ctx.storage.get(key);
    if (value === undefined) fail('Note not found', 'notes/not-found');
    return record(value, key);
  };
  const all = async (): Promise<Note[]> => {
    // ponytail: lists/counts scan records; add a metadata index if notebook scans become slow.
    const notes: Note[] = [];
    for (const key of await ctx.storage.keys()) {
      if (!key.startsWith(prefix)) continue;
      notes.push(await get(key.slice(prefix.length)));
    }
    return notes;
  };
  for (const note of await all()) lastCreated = Math.max(lastCreated, instant(note.createdAt));
  guard();
  const save = async (note: Note) => {
    guard();
    await ctx.storage.set(`${prefix}${note.id}`, { schemaVersion: 1, note } as unknown as Json);
  };
  const notify = (type: 'notes/created' | 'notes/updated', note: Note, causedBy: string) => {
    if (!disposed) ctx.bus.emit(type, { note }, { causedBy });
  };
  const detach = async (questId: string, causedBy: string) => {
    for (const note of await all()) {
      if (note.questId !== questId) continue;
      const next = { ...note, updatedAt: new Date(ctx.clock.now()).toISOString() };
      delete next.questId;
      await save(next);
      notify('notes/updated', next, causedBy);
    }
  };
  const register = <K extends keyof NotesRequests>(
    type: K, handler: (payload: RequestPayload<K>, envelope: Envelope) => Promise<ResponseData<K>>,
  ) => ctx.bus.handle(type, (payload, envelope) => enqueue(() => {
    object(payload);
    return handler(payload, envelope);
  }));

  register('notes/create', async (payload, envelope) => {
    const input = object(payload.input);
    const body = text(input.text);
    const questId = input.questId === undefined ? undefined : identifier(input.questId);
    if (questId !== undefined) {
      try { await ctx.bus.request('quest/get', { id: questId }); }
      catch (cause) {
        if (cause instanceof Error && 'code' in cause && cause.code === 'quest/not-found') fail('Quest does not exist');
        throw cause;
      }
    }
    const time = Math.max(ctx.clock.now(), lastCreated + 1);
    const at = new Date(time).toISOString();
    const note: Note = { id: crypto.randomUUID(), text: body, createdAt: at, updatedAt: at,
      ...(questId === undefined ? {} : { questId }) };
    await save(note);
    lastCreated = time;
    notify('notes/created', note, envelope.id);
    return { note };
  });
  register('notes/get', async payload => ({ note: await get(identifier(payload.id)) }));
  register('notes/update', async (payload, envelope) => {
    const id = identifier(payload.id);
    const body = text(payload.text);
    const note = await get(id);
    if (body === note.text) return { note };
    const next = { ...note, text: body, updatedAt: new Date(ctx.clock.now()).toISOString() };
    await save(next);
    notify('notes/updated', next, envelope.id);
    return { note: next };
  });
  register('notes/delete', async (payload, envelope) => {
    const note = await get(identifier(payload.id));
    guard();
    await ctx.storage.delete(`${prefix}${note.id}`);
    if (!disposed) ctx.bus.emit('notes/deleted', { id: note.id,
      ...(note.questId === undefined ? {} : { questId: note.questId }) }, { causedBy: envelope.id });
    return null;
  });
  register('notes/list', async payload => {
    const questId = payload.questId === undefined || payload.questId === null
      ? payload.questId : identifier(payload.questId);
    if (payload.query !== undefined && typeof payload.query !== 'string') fail('Expected a text query');
    const query = payload.query?.toLowerCase();
    const before = payload.before === undefined ? Infinity : instant(payload.before);
    const limit = payload.limit === undefined ? 50 : payload.limit;
    if (!Number.isSafeInteger(limit) || limit < 1) fail('Limit must be a positive integer');
    const notes = (await all()).filter(note =>
      (questId === undefined || (questId === null ? note.questId === undefined : note.questId === questId)) &&
      (query === undefined || note.text.toLowerCase().includes(query)) && instant(note.createdAt) < before)
      .sort((a, b) => instant(b.createdAt) - instant(a.createdAt) || b.id.localeCompare(a.id));
    return { notes: notes.slice(0, limit), more: notes.length > limit };
  });
  register('notes/counts', async payload => {
    if (!Array.isArray(payload.questIds)) fail('Expected quest ids');
    const ids = payload.questIds.map(identifier);
    const counts = Object.fromEntries(ids.map(id => [id, 0]));
    for (const note of await all()) {
      if (note.questId !== undefined && Object.hasOwn(counts, note.questId)) counts[note.questId]!++;
    }
    return { counts };
  });
  ctx.bus.on('quest/deleted', (payload, envelope) => enqueue(async () => {
    await detach(identifier(payload.id), envelope.id);
  }));
  ctx.bus.on('kernel/ready', (_, envelope) => enqueue(async () => {
    const ids = new Set((await all()).map(note => note.questId).filter(id => id !== undefined));
    for (const id of ids) {
      try { await ctx.bus.request('quest/get', { id }); }
      catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'quest/not-found')) throw cause;
        // Events do not replay: repair associations missed during a crash or failed write.
        await detach(id, envelope.id);
      }
    }
  }));
}
