import type { ChronicleEntry, Json, Logger, PluginStorage } from '@featherlog/contracts';
import { attributes, initialState } from './model';
import type { State } from './model';

type Reference = { month: string; key: string };
const recordKey = /^chronicle:\d{4}-\d{2}:[0-9a-f-]{36}$/;
export function valid(value: unknown, message: string): asserts value {
  if (!value) throw Object.assign(new Error(message), { code: 'character/invalid-input' });
}
export function object(value: unknown): asserts value is Record<string, unknown> {
  valid(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
}
function string(value: unknown): asserts value is string {
  valid(typeof value === 'string' && value.length > 0, 'Expected nonempty text');
}
function integer(value: unknown): asserts value is number {
  valid(Number.isSafeInteger(value) && Number(value) >= 0, 'Expected a nonnegative integer');
}
export function instant(value: unknown): number {
  string(value);
  valid(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value), 'Expected an ISO timestamp with a time zone');
  const time = Date.parse(value);
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  valid(Number.isFinite(time) && Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value.slice(0, 10), 'Invalid timestamp');
  return time;
}
function strings(value: unknown): asserts value is string[] {
  valid(Array.isArray(value), 'Expected an array');
  value.forEach(string);
  valid(new Set(value).size === value.length, 'Duplicate ids');
}
function validateState(value: unknown): asserts value is State {
  object(value);
  valid(value.schemaVersion === 1 && typeof value.initialized === 'boolean', 'Invalid character schema');
  valid(Array.isArray(value.accounts) && Array.isArray(value.titles) && Array.isArray(value.ranks), 'Invalid character state');
  valid(value.ranks.length === 4, 'Expected four ranks');
  value.ranks.forEach(rank => { integer(rank); valid(rank <= 6, 'Invalid rank'); });
  const ids: string[] = [];
  for (const account of value.accounts) {
    object(account); string(account.id); string(account.label); ids.push(account.id);
    valid(['main', 'side', 'daily'].includes(String(account.kind)), 'Invalid quest kind');
    strings(account.attributes);
    valid(account.attributes.length <= 2 && account.attributes.every(attribute => attributes.some(known => known === attribute)), 'Invalid attributes');
    integer(account.points); integer(account.streak);
    for (const key of ['completed', 'onTime', 'deleted']) valid(typeof account[key] === 'boolean', 'Invalid account flag');
    strings(account.chapters); strings(account.periods);
    valid(account.periods.every(period => /^\d{4}-\d{2}-\d{2}$/.test(period)), 'Invalid period');
    valid(Array.isArray(account.objectives), 'Invalid objective accounts');
    const objectives: string[] = [];
    for (const objective of account.objectives) {
      object(objective); string(objective.id); objectives.push(objective.id);
      integer(objective.count); valid(objective.count <= 20 && typeof objective.done === 'boolean', 'Invalid objective account');
    }
    valid(new Set(objectives).size === objectives.length, 'Duplicate objectives');
  }
  valid(new Set(ids).size === ids.length, 'Duplicate accounts');
  const titles: string[] = [];
  for (const title of value.titles) {
    object(title); string(title.id); string(title.name); string(title.hint); titles.push(title.id);
    if (title.earnedAt !== undefined) instant(title.earnedAt);
    valid(initialState().titles.some(fixed => fixed.id === title.id) || title.questId !== undefined, 'Unknown stored title');
    if (title.questId !== undefined) {
      string(title.questId);
      valid(title.id === `gift:${title.questId}` && title.earnedAt !== undefined, 'Invalid gift title');
    }
  }
  valid(new Set(titles).size === titles.length && initialState().titles.every(title => titles.includes(title.id)), 'Invalid titles');
  valid(value.worn === null || value.titles.some(title => title.id === value.worn && title.earnedAt), 'Invalid worn title');
}
function validateEntries(value: unknown, month: string): asserts value is ChronicleEntry[] {
  valid(Array.isArray(value), 'Invalid chronicle shard');
  const ids: string[] = [];
  for (const item of value) {
    object(item); string(item.id); ids.push(item.id); instant(item.at);
    valid(String(item.at).slice(0, 7) === month, 'Chronicle month mismatch');
    switch (item.kind) {
      case 'quest-completed':
        valid(item.questKind === 'main' || item.questKind === 'side', 'Invalid chronicle quest kind');
        string(item.questId); string(item.label); break;
      case 'chapter-completed': string(item.questId); string(item.label);
        valid(typeof item.chapterTitle === 'string', 'Invalid chapter title'); break;
      case 'rank': integer(item.rank); string(item.rankName);
        valid(item.rank >= 1 && item.rank <= 6 && attributes.some(known => known === item.attribute), 'Invalid chronicle rank'); break;
      case 'title': string(item.titleId); string(item.titleName); break;
      default: valid(false, 'Invalid chronicle entry');
    }
  }
  valid(new Set(ids).size === ids.length, 'Duplicate chronicle entries');
}

export async function openState(storage: PluginStorage, log: Logger) {
  const stored = await storage.get('state');
  let state: State = initialState();
  let references: Reference[] = [];
  const months = new Map<string, ChronicleEntry[]>();
  if (stored !== undefined) {
    object(stored); validateState(stored.state); state = stored.state;
    valid(Array.isArray(stored.months), 'Invalid chronicle index');
    for (const reference of stored.months) {
      object(reference); string(reference.month); string(reference.key);
      valid(/^\d{4}-(0[1-9]|1[0-2])$/.test(reference.month) && recordKey.test(reference.key) &&
        reference.key.startsWith(`chronicle:${reference.month}:`) && !months.has(reference.month), 'Invalid chronicle reference');
      const entries = await storage.get(reference.key);
      validateEntries(entries, reference.month);
      months.set(reference.month, entries);
      references.push({ month: reference.month, key: reference.key });
    }
  }
  const remove = async (keys: string[]) => {
    for (const key of keys) {
      try { await storage.delete(key); }
      catch (cause) { log.warn('Could not remove unused character shard', { key, cause }); }
    }
  };
  // Validate every referenced shard before deleting any crash leftovers.
  try {
    const retained = new Set(references.map(reference => reference.key));
    await remove((await storage.keys()).filter(key => recordKey.test(key) && !retained.has(key)));
  } catch (cause) { log.warn('Could not list unused character shards', cause); }
  return {
    get state() { return state; },
    entries: () => [...months.values()].flat(),
    async save(next: State, entries: ChronicleEntry[]) {
      const changed = new Map<string, ChronicleEntry[]>();
      for (const item of entries) {
        const month = item.at.slice(0, 7);
        if (!changed.has(month)) changed.set(month, [...(months.get(month) ?? [])]);
        changed.get(month)!.push(item);
      }
      const staged: Reference[] = [];
      let updated: Reference[];
      try {
        for (const [month, items] of changed) {
          const reference = { month, key: `chronicle:${month}:${crypto.randomUUID()}` };
          staged.push(reference);
          await storage.set(reference.key, items as unknown as Json);
        }
        updated = [...references.filter(reference => !changed.has(reference.month)), ...staged];
        // One atomic pointer replacement commits the ledger, titles and all changed months together.
        await storage.set('state', { state: next, months: updated } as unknown as Json);
      } catch (cause) {
        await remove(staged.map(reference => reference.key));
        throw cause;
      }
      const obsolete = references.filter(reference => changed.has(reference.month));
      state = next;
      references = updated;
      for (const [month, items] of changed) months.set(month, items);
      await remove(obsolete.map(reference => reference.key));
    },
  };
}
