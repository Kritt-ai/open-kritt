import { describe, expect, it } from 'vitest';
import { newestFirst, paginate, paginationTokens } from './pagination.js';

describe('newestFirst', () => {
  it('sorts by creation date descending with newest ids breaking timestamp ties', () => {
    const items = [
      { id: '2', insertedAt: '2026-07-18T10:00:00Z' },
      { id: '10', insertedAt: '2026-07-20T10:00:00Z' },
      { id: '9', insertedAt: '2026-07-20T10:00:00Z' },
      { id: '3', insertedAt: '2026-07-19T10:00:00Z' },
    ];

    expect(newestFirst(items).map((item) => item.id)).toEqual(['10', '9', '3', '2']);
    expect(items.map((item) => item.id)).toEqual(['2', '10', '9', '3']);
  });

  it('puts undated records last and orders them by numeric id as a legacy fallback', () => {
    const items = [
      { id: '99' },
      { id: '100' },
      { id: '4', insertedAt: 'invalid' },
      { id: '1', insertedAt: '2026-07-20T10:00:00Z' },
    ];

    expect(newestFirst(items).map((item) => item.id)).toEqual(['1', '100', '99', '4']);
  });
});

describe('paginate', () => {
  it('returns only the requested page and exposes its visible range', () => {
    const result = paginate(
      Array.from({ length: 27 }, (_, index) => index + 1),
      2,
      10
    );

    expect(result.pageItems).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(result).toMatchObject({
      page: 2,
      pageSize: 10,
      totalItems: 27,
      totalPages: 3,
      startIndex: 10,
      endIndex: 20,
    });
  });

  it('clamps invalid and stale pages without mutating the input', () => {
    const items = ['a', 'b', 'c'];

    expect(paginate(items, 99, 2)).toMatchObject({ page: 2, pageItems: ['c'] });
    expect(paginate(items, -4, 0)).toMatchObject({ page: 1, pageSize: 12, pageItems: items });
    expect(items).toEqual(['a', 'b', 'c']);
  });
});

describe('paginationTokens', () => {
  it('shows all small page ranges and compacts large ranges around the current page', () => {
    expect(paginationTokens(2, 4)).toEqual([1, 2, 3, 4]);
    expect(paginationTokens(8, 20)).toEqual([1, 'ellipsis-1-7', 7, 8, 9, 'ellipsis-9-20', 20]);
  });
});
