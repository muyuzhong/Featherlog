import { describe, expect, it } from 'vitest';
import { readFields } from './schema';

describe('readFields', () => {
  it('reads a bounded integer with its title and description', () => {
    const schema = {
      type: 'object',
      properties: {
        dayStartHour: {
          type: 'integer',
          title: '一天从几点开始',
          description: '在这个时间之前完成的日常，算作前一天。',
          minimum: 0,
          maximum: 23,
          default: 4,
        },
      },
    };
    expect(readFields(schema)).toEqual([
      {
        key: 'dayStartHour',
        kind: 'number',
        integer: true,
        min: 0,
        max: 23,
        title: '一天从几点开始',
        description: '在这个时间之前完成的日常，算作前一天。',
      },
    ]);
  });

  it('reads every type the shell validates, keeping property order', () => {
    const fields = readFields({
      type: 'object',
      properties: {
        volume: { type: 'number', minimum: 0 },
        quiet: { type: 'boolean', title: '安静' },
        mood: { type: 'string', enum: ['calm', 'busy'], oneOf: [{ const: 'calm', title: '平静' }] },
        motto: { type: 'string' },
      },
    });
    expect(fields).toEqual([
      { key: 'volume', title: 'volume', kind: 'number', integer: false, min: 0 },
      { key: 'quiet', title: '安静', kind: 'boolean' },
      {
        key: 'mood',
        title: 'mood',
        kind: 'choice',
        options: [
          { value: 'calm', label: '平静' },
          { value: 'busy', label: 'busy' },
        ],
      },
      { key: 'motto', title: 'motto', kind: 'text' },
    ]);
  });

  it('leaves out properties the shell cannot validate, and tolerates malformed schemas', () => {
    expect(readFields({ type: 'object', properties: { tags: { type: 'array' }, broken: 3, nested: { type: 'object' } } })).toEqual([]);
    expect(readFields(null)).toEqual([]);
    expect(readFields({ type: 'object' })).toEqual([]);
    expect(readFields([])).toEqual([]);
  });

  it('reads a write-only string as a secret, never as plain text', () => {
    expect(readFields({ type: 'object', properties: { apiKey: { type: 'string', title: 'API Key', writeOnly: true } } })).toEqual([
      { key: 'apiKey', title: 'API Key', kind: 'secret' },
    ]);
  });
});
