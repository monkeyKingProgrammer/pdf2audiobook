import { describe, expect, it } from 'vitest';
import { cleanPageText, chunkText, normalizeBookText, selectPageRange } from './text.js';

describe('book text processing', () => {
  it('repairs line-break hyphenation', () => expect(cleanPageText('wonder-\nful')).toBe('wonderful'));
  it('removes repeated headers', () => {
    const pages = ['A BOOK\nFirst page', 'A BOOK\nSecond page', 'A BOOK\nThird page'];
    expect(normalizeBookText(pages)).not.toContain('A BOOK');
  });
  it('chunks without losing content', () => {
    const input = 'One short sentence. '.repeat(300);
    const chunks = chunkText(input, 180);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 180)).toBe(true);
  });
  it('selects and safely clamps an inclusive page range', () => {
    const pages = ['one', 'two', 'three', 'four'];
    expect(selectPageRange(pages, 2, 3)).toEqual(['two', 'three']);
    expect(selectPageRange(pages, -4, 99)).toEqual(pages);
    expect(selectPageRange(pages, 4, 2)).toEqual(['four']);
  });
});
