/**
 * Server-streaming wrapper. Yields events one at a time, transparently
 * filters HEARTBEAT events unless the caller opts in, and reconnects on
 * transient network failures (Watch RPCs are idempotent — every reconnect
 * starts with a SNAPSHOT event).
 */

import { APIConnectionError } from "./errors.js";

export interface WatchOptions<T> {
  /** Yield HEARTBEAT events instead of filtering them out. Default: false. */
  includeHeartbeats?: boolean;
  /** Predicate identifying a HEARTBEAT event in this stream's event type. */
  isHeartbeat?: (event: T) => boolean;
  /** Maximum reconnect attempts on transient failures. Default: 5. */
  maxReconnects?: number;
  /** Cancel the watch by aborting this signal. */
  signal?: AbortSignal;
}

export type WatchFactory<T> = (signal: AbortSignal) => AsyncIterable<T>;

/**
 * Wrap a raw stream factory with reconnect + heartbeat-filtering semantics.
 * The factory is called once per connection; if it throws an
 * `APIConnectionError` we re-invoke it with backoff, up to `maxReconnects`.
 */
export async function* watch<T>(
  factory: WatchFactory<T>,
  opts: WatchOptions<T> = {},
): AsyncIterable<T> {
  const max = opts.maxReconnects ?? 5;
  const isHeartbeat = opts.isHeartbeat;
  let attempt = 0;
  while (true) {
    const ac = new AbortController();
    const onAbort = () => ac.abort(opts.signal!.reason);
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", onAbort);
    }
    try {
      for await (const event of factory(ac.signal)) {
        if (!opts.includeHeartbeats && isHeartbeat && isHeartbeat(event)) continue;
        yield event;
      }
      return;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (!(err instanceof APIConnectionError)) throw err;
      attempt++;
      if (attempt > max) throw err;
      await backoff(attempt);
    } finally {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    }
  }
}

function backoff(attempt: number): Promise<void> {
  const base = 500;
  const cap = 5000;
  const expo = Math.min(cap, base * 2 ** (attempt - 1));
  const jittered = expo * (0.5 + Math.random() * 0.5);
  return new Promise((resolve) => setTimeout(resolve, jittered));
}
