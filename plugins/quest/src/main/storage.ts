import type { Json, Logger, PluginStorage } from '@featherlog/contracts';
import { input, object, valid } from './model';
import type { State } from './model';

type Reference = { id: string; key: string };
const recordKey = /^record:[0-9a-f-]{36}$/;

function validateState(value: unknown): asserts value is State {
  object(value);
  valid(value.schemaVersion === 1, 'Unsupported quest schemaVersion');
  valid(Array.isArray(value.quests), 'Invalid stored quests');
  object(value.history);
  object(value.meta);
  valid(typeof value.meta.lastPeriodKey === 'string', 'Invalid stored period');
  const ids = new Set<string>();
  for (const quest of value.quests) {
    object(quest);
    input({ ...quest, chapters: quest.kind === 'daily' ? undefined : quest.chapters });
    valid(typeof quest.id === 'string' && typeof quest.createdAt === 'string',
      'Invalid stored quest');
    valid(!ids.has(quest.id), 'Duplicate stored quest');
    ids.add(quest.id);
  }
  for (const [id, days] of Object.entries(value.history)) {
    valid(ids.has(id) && Array.isArray(days) && days.every(day => typeof day === 'string'),
      'Invalid stored history');
  }
}

export async function openState(storage: PluginStorage, log: Logger, period: string) {
  const stored = await storage.get('state');
  let references: Reference[] = [];
  let loaded: unknown = stored ?? {
    schemaVersion: 1, quests: [], history: {}, meta: { lastPeriodKey: period },
  };
  if (stored !== undefined) {
    object(stored);
    valid(stored.schemaVersion === 1 || stored.schemaVersion === 2,
      'Unsupported quest schemaVersion');
    if (stored.schemaVersion === 2) {
      valid(Array.isArray(stored.quests), 'Invalid stored quest index');
      const quests: unknown[] = [];
      const history: Record<string, unknown> = Object.create(null);
      for (const reference of stored.quests) {
        object(reference);
        valid(typeof reference.id === 'string' && typeof reference.key === 'string' &&
          recordKey.test(reference.key), 'Invalid stored quest reference');
        const record = await storage.get(reference.key);
        object(record);
        object(record.quest);
        valid(record.quest.id === reference.id, 'Stored quest reference mismatch');
        quests.push(record.quest);
        history[reference.id] = record.history;
        references.push({ id: reference.id, key: reference.key });
      }
      loaded = { schemaVersion: 1, quests, history, meta: stored.meta };
    }
  }
  validateState(loaded);
  let state = loaded;
  const remove = async (keys: string[]) => {
    for (const key of keys) {
      try { await storage.delete(key); }
      catch (cause) { log.warn('Could not remove unused quest record', { key, cause }); }
    }
  };
  const save = async (next: State) => {
    const previous = new Map(state.quests.map(quest => [quest.id, quest]));
    const keys = new Map(references.map(reference => [reference.id, reference.key]));
    const staged: string[] = [];
    const updated: Reference[] = [];
    try {
      for (const quest of next.quests) {
        let key = keys.get(quest.id);
        if (!key || previous.get(quest.id) !== quest ||
          state.history[quest.id] !== next.history[quest.id]) {
          key = `record:${crypto.randomUUID()}`;
          staged.push(key);
          await storage.set(key, { quest, history: next.history[quest.id] ?? [] } as unknown as Json);
        }
        updated.push({ id: quest.id, key });
      }
      // Only this atomic replacement makes the immutable records visible together.
      // ponytail: the index is O(quest count); use a database if this small write becomes costly.
      await storage.set('state', { schemaVersion: 2, quests: updated, meta: next.meta });
    } catch (cause) {
      await remove(staged);
      throw cause;
    }
    const retained = new Set(updated.map(reference => reference.key));
    const obsolete = references.filter(reference => !retained.has(reference.key));
    references = updated;
    state = next;
    // Cleanup failure cannot turn a committed request into a reported failure.
    await remove(obsolete.map(reference => reference.key));
  };
  if (stored === undefined || (stored as Record<string, unknown>).schemaVersion === 1) {
    await save(state);
  }
  // Crashes before the index commit can leave records behind, but never a partial state.
  const retained = new Set(references.map(reference => reference.key));
  try {
    await remove((await storage.keys()).filter(key => recordKey.test(key) && !retained.has(key)));
  } catch (cause) { log.warn('Could not list unused quest records', cause); }
  return { state, save };
}
