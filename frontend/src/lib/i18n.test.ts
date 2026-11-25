import { describe, expect, it } from 'vitest';
import { LANGUAGE_NAMES, type Messages, messages, normalizeLanguage, noticeText, parseLanguage } from './i18n';

/** Every leaf of a catalogue as [path, value], calling functions with sample arguments. */
function leaves(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'function') {
    const args = Array.from({ length: value.length }, (_, i) => (i === 0 ? 2 : i === 1 ? '2026-11-28' : 'x'));
    return [[path, String((value as (...a: unknown[]) => unknown)(...args))]];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
}

describe('language tags', () => {
  it('reads zh, zh-CN and its spellings as zh, en-* as en, anything else as nothing', () => {
    for (const tag of ['zh', 'zh-CN', 'ZH-cn', 'zh_Hans', ' zh-TW ']) expect(parseLanguage(tag)).toBe('zh');
    for (const tag of ['en', 'en-US', 'EN_gb']) expect(parseLanguage(tag)).toBe('en');
    for (const tag of ['fr', 'zhx', 'english', '', null, undefined, 3, {}]) expect(parseLanguage(tag)).toBeNull();
  });

  it('falls back to zh when the value is missing or unknown', () => {
    expect(normalizeLanguage(undefined)).toBe('zh');
    expect(normalizeLanguage('ja')).toBe('zh');
    expect(normalizeLanguage('zh-CN')).toBe('zh');
    expect(normalizeLanguage('en')).toBe('en');
  });
});

describe('catalogues', () => {
  const zh = messages('zh');
  const en = messages('en');

  it('English says everything Chinese says, key for key', () => {
    expect(leaves(en).map(([p]) => p)).toEqual(leaves(zh).map(([p]) => p));
    // Only the words around the time left may be empty: each language puts them on one side.
    const optional = new Set(['slot.leftBefore', 'slot.leftAfter']);
    for (const [path, text] of [...leaves(zh), ...leaves(en)]) if (!optional.has(path)) expect(text.trim(), path).not.toBe('');
    expect(zh.slot.leftBefore + zh.slot.leftAfter).toBe('还剩 ');
    expect(en.slot.leftBefore + en.slot.leftAfter).toBe(' left');
  });

  it('English carries no Chinese but the language name it switches to', () => {
    const han = leaves(en).filter(([, text]) => /[\u4e00-\u9fff]/.test(text.replace(LANGUAGE_NAMES.zh, '')));
    expect(han).toEqual([]);
  });

  it('names each language in itself, and tags <html> for the right glyphs', () => {
    expect(LANGUAGE_NAMES).toEqual({ zh: '简体中文', en: 'English' });
    expect(zh.htmlLang).toBe('zh-CN');
    expect(en.htmlLang).toBe('en');
    expect(zh.palette.language).toBe('切换语言为 English');
    expect(en.palette.language).toBe('Switch language to 简体中文');
  });

  it('counts in English with singulars', () => {
    expect(en.deck.count(1)).toBe('1 card');
    expect(en.deck.count(3)).toBe('3 cards');
    expect(en.tasks.dailyOn(4, 0)).toBe('Resets daily at 4:00');
    expect(en.tasks.dailyOn(4, 1)).toBe('Resets daily at 4:00 · 1 day in a row');
    expect(zh.tasks.dailyOn(4, 9)).toBe('每天 4:00 清零 · 已连续 9 天');
    expect(en.tray.hiddenReady(2)).toBe('2 more cards ready on the back');
  });

  it('words a failed call in either language, with a fallback for an empty error', () => {
    const notice = { action: 'saveNote', detail: 'notes/content-required' } as const;
    expect(noticeText(zh, notice)).toBe('保存随笔失败：notes/content-required');
    expect(noticeText(en, notice)).toBe('Saving the note failed: notes/content-required');
    expect(noticeText(en, { action: 'connect', detail: '' })).toBe('Connecting to the backend failed: unknown error');
    expect(noticeText(zh, { action: 'connect', detail: '' })).toBe('连接后端失败：未知错误');
  });

  it('is typed so a missing English string would not compile', () => {
    const shape: Messages = en;
    expect(shape.appName).toBe('Featherlog');
  });
});
