import { describe, it, expect, vi } from 'vitest';
import { fetchAllPages } from './pagination';

describe('fetchAllPages', () => {
  it('follows the cursor until the API stops returning one', async () => {
    const fetchPage = vi
      .fn<(startKey?: string) => Promise<{ items: number[]; nextStartKey?: string | null }>>()
      .mockResolvedValueOnce({ items: [1], nextStartKey: 'a' })
      .mockResolvedValueOnce({ items: [2], nextStartKey: 'b' })
      .mockResolvedValueOnce({ items: [3], nextStartKey: null });

    const pages = await fetchAllPages(fetchPage);

    expect(pages.map((p) => p.items)).toEqual([[1], [2], [3]]);
    expect(fetchPage.mock.calls).toEqual([[undefined], ['a'], ['b']]);
  });

  it('stops after one call when there is no cursor', async () => {
    const fetchPage = vi.fn<() => Promise<{ nextStartKey?: string }>>().mockResolvedValue({});

    await fetchAllPages(fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
