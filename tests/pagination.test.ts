import { describe, expect, it, vi } from "vitest";

import { Page, type PageContents } from "../src/pagination.js";

function fakePages<T>(pages: PageContents<T>[]): {
  fetch: (cursor: string | undefined) => Promise<PageContents<T>>;
  cursors: (string | undefined)[];
} {
  let i = 0;
  const cursors: (string | undefined)[] = [];
  return {
    cursors,
    fetch: async (cursor) => {
      cursors.push(cursor);
      const page = pages[i++];
      if (!page) throw new Error("ran out of pages");
      return page;
    },
  };
}

describe("Page", () => {
  it("await page resolves to the first page only", async () => {
    const { fetch } = fakePages([
      { items: [1, 2, 3], nextCursor: "c1" },
      { items: [4, 5], nextCursor: undefined },
    ]);
    const page = new Page(fetch);
    const first = await page;
    expect(first.items).toEqual([1, 2, 3]);
    expect(first.nextCursor).toBe("c1");
  });

  it("caches the first fetch (await twice → one network call)", async () => {
    const fetch = vi.fn(async () => ({ items: [1], nextCursor: undefined }));
    const page = new Page(fetch);
    await page;
    await page;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("autoPage iterates every item across pages and stops on empty cursor", async () => {
    const { fetch, cursors } = fakePages<number>([
      { items: [1, 2], nextCursor: "c1" },
      { items: [3, 4], nextCursor: "c2" },
      { items: [5], nextCursor: undefined },
    ]);
    const page = new Page(fetch);
    const all: number[] = [];
    for await (const v of page.autoPage()) all.push(v);
    expect(all).toEqual([1, 2, 3, 4, 5]);
    expect(cursors).toEqual([undefined, "c1", "c2"]);
  });

  it("autoPage stops immediately when the first page is empty", async () => {
    const { fetch } = fakePages([{ items: [], nextCursor: undefined }]);
    const page = new Page(fetch);
    const out: number[] = [];
    for await (const v of page.autoPage()) out.push(v as number);
    expect(out).toEqual([]);
  });

  it("autoPage propagates fetcher errors", async () => {
    const page = new Page<number>(async (cursor) => {
      if (cursor === undefined) return { items: [1], nextCursor: "c1" };
      throw new Error("boom");
    });
    const iter = page.autoPage();
    await expect(iter.next()).resolves.toEqual({ value: 1, done: false });
    await expect(iter.next()).rejects.toThrow("boom");
  });
});
