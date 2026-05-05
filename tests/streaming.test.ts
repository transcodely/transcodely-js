import { describe, expect, it } from "vitest";

import { APIConnectionError, NotFoundError } from "../src/errors.js";
import { watch, type WatchFactory } from "../src/streaming.js";

interface Event {
  kind: "snapshot" | "update" | "heartbeat";
  n: number;
}

function asIterable<T>(items: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

function failingThen<T>(
  errorSequence: Array<Error | null>,
  factory: WatchFactory<T>,
): WatchFactory<T> {
  let i = 0;
  return (signal) => {
    const err = errorSequence[i++];
    if (err) {
      // Return an iterable that throws on first iteration.
      return (async function* () {
        throw err;
        // unreachable, satisfies generator contract
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        yield undefined as unknown as T;
      })();
    }
    return factory(signal);
  };
}

describe("watch", () => {
  it("yields events in order without filtering when no isHeartbeat predicate", async () => {
    const events: Event[] = [
      { kind: "snapshot", n: 0 },
      { kind: "update", n: 1 },
      { kind: "heartbeat", n: 2 },
    ];
    const factory: WatchFactory<Event> = () => asIterable(events);
    const out: Event[] = [];
    for await (const ev of watch(factory)) out.push(ev);
    expect(out).toEqual(events);
  });

  it("filters HEARTBEAT events when predicate is provided", async () => {
    const events: Event[] = [
      { kind: "snapshot", n: 0 },
      { kind: "heartbeat", n: 1 },
      { kind: "update", n: 2 },
      { kind: "heartbeat", n: 3 },
    ];
    const factory: WatchFactory<Event> = () => asIterable(events);
    const out: Event[] = [];
    for await (const ev of watch(factory, { isHeartbeat: (e) => e.kind === "heartbeat" })) {
      out.push(ev);
    }
    expect(out.map((e) => e.n)).toEqual([0, 2]);
  });

  it("includes heartbeats when includeHeartbeats:true even with predicate", async () => {
    const events: Event[] = [
      { kind: "snapshot", n: 0 },
      { kind: "heartbeat", n: 1 },
    ];
    const factory: WatchFactory<Event> = () => asIterable(events);
    const out: Event[] = [];
    for await (const ev of watch(factory, {
      includeHeartbeats: true,
      isHeartbeat: (e) => e.kind === "heartbeat",
    })) {
      out.push(ev);
    }
    expect(out).toEqual(events);
  });

  it("reconnects on APIConnectionError and resumes from the new stream", async () => {
    const realFactory: WatchFactory<Event> = () =>
      asIterable([{ kind: "snapshot", n: 99 }]);
    const factory = failingThen(
      [new APIConnectionError({ message: "transient" }), null],
      realFactory,
    );
    const out: Event[] = [];
    for await (const ev of watch(factory, { maxReconnects: 3 })) out.push(ev);
    expect(out).toEqual([{ kind: "snapshot", n: 99 }]);
  });

  it("does NOT reconnect on a non-connection error (e.g. NotFoundError)", async () => {
    const factory: WatchFactory<Event> = () => {
      return (async function* () {
        throw new NotFoundError({ message: "missing" });
        // eslint-disable-next-line @typescript-eslint/no-unreachable
        yield undefined as unknown as Event;
      })();
    };
    await expect(async () => {
      for await (const _ev of watch(factory)) {
        /* drain */
      }
    }).rejects.toBeInstanceOf(NotFoundError);
  });

  it("gives up after maxReconnects is exceeded", async () => {
    const factory: WatchFactory<Event> = () => {
      return (async function* () {
        throw new APIConnectionError({ message: "down" });
        // eslint-disable-next-line @typescript-eslint/no-unreachable
        yield undefined as unknown as Event;
      })();
    };
    await expect(async () => {
      for await (const _ev of watch(factory, { maxReconnects: 0 })) {
        /* drain */
      }
    }).rejects.toBeInstanceOf(APIConnectionError);
  });
});
