/**
 * Cursor pagination helper. Every `list` method returns a `Page<T>` so callers
 * can either paginate manually or `.autoPage()` to iterate every result.
 *
 * @example
 * ```ts
 * for await (const job of client.jobs.list({ limit: 50 }).autoPage()) {
 *   console.log(job.id);
 * }
 * ```
 *
 * Decoupled from the proto types so resources with non-standard pagination
 * (e.g. Video uses page_size/page_token instead of pagination.cursor) can
 * still expose the same surface.
 */

export interface PageContents<T> {
  items: T[];
  nextCursor: string | undefined;
}

/** Fetcher: given a cursor (undefined for the first page), return the next page. */
export type FetchPage<T> = (cursor: string | undefined) => Promise<PageContents<T>>;

/**
 * Lazily-iterable page wrapper. Acts as both a sync container (await it for
 * the first page) and an async iterator over all items via `.autoPage()`.
 */
export class Page<T> implements PromiseLike<PageContents<T>> {
  private cached: Promise<PageContents<T>> | undefined;

  constructor(private readonly fetcher: FetchPage<T>) {}

  /** Fetch (or return cached) the first page. */
  fetch(): Promise<PageContents<T>> {
    if (!this.cached) this.cached = this.fetcher(undefined);
    return this.cached;
  }

  /** PromiseLike — `await page` resolves to the first page. */
  then<TResult1 = PageContents<T>, TResult2 = never>(
    onfulfilled?: ((value: PageContents<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.fetch().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }

  /** Iterate items across every page automatically. */
  async *autoPage(): AsyncIterableIterator<T> {
    let cursor: string | undefined;
    while (true) {
      const page = await this.fetcher(cursor);
      for (const item of page.items) yield item;
      if (!page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }
}
