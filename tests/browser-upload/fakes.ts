/**
 * Doubles for the browser uploader tests: one `fetch` that plays both the
 * app's upload endpoint (speaking the wire protocol directly, no handler) and
 * the object store the part URLs point at. Every endpoint call and every PUT
 * is recorded so a test can assert exactly what went over the wire.
 */

import type { UploadRequest } from "../../src/browser-upload/index.js";

export const ENDPOINT = "/api/upload";

export interface Put {
  part: number;
  body: Uint8Array;
}

export interface FakeOptions {
  partSize?: number;
  /** Part number to the HTTP statuses it answers before succeeding. */
  failures?: Record<number, number[]>;
  /** Answer `sign_parts` (or every non-create call) with this error. */
  endpointError?: { status: number; code: string; message: string; actions?: string[] };
  omitEtag?: boolean;
  ttlMs?: number;
}

export function fakeBackend(opts: FakeOptions = {}) {
  const partSize = opts.partSize ?? 4;
  const calls: UploadRequest[] = [];
  const puts: Put[] = [];
  const failures = structuredClone(opts.failures ?? {});
  let uploads = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let held: (() => void)[] | undefined;
  /** PUTs that were started and then aborted by the uploader. */
  let abortedPuts = 0;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const urls = (vid: string, nums: number[]) => nums.map((n) => ({ part_number: n, url: `https://storage.test/${vid}/${String(n)}` }));
  const soon = () => new Date(Date.now() + 3_600_000).toISOString();

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === ENDPOINT) {
      const body = JSON.parse(String(init?.body)) as UploadRequest;
      calls.push(body);
      const err = opts.endpointError;
      if (err && body.action !== "create" && (!err.actions || err.actions.includes(body.action))) {
        return json(err.status, { error: { code: err.code, message: err.message } });
      }
      switch (body.action) {
        case "create": {
          const vid = `vid_${String(++uploads)}`;
          const total = Math.max(1, Math.ceil(body.file.size / partSize));
          return json(200, {
            ticket: `ticket-${vid}`,
            video_id: vid,
            upload_id: `up-${vid}`,
            part_size: partSize,
            total_parts: total,
            expires_at: new Date(Date.now() + (opts.ttlMs ?? 86_400_000)).toISOString(),
            parts: urls(vid, Array.from({ length: Math.min(total, 2) }, (_, i) => i + 1)),
            urls_expire_at: soon(),
          });
        }
        case "sign_parts":
          return json(200, { parts: urls(body.ticket.slice(7), body.part_numbers), urls_expire_at: soon() });
        case "complete":
          return json(200, { video_id: body.ticket.slice(7), status: "processing" });
        case "abort":
          return json(200, {});
      }
    }
    const m = /^https:\/\/storage\.test\/[^/]+\/(\d+)$/.exec(url);
    if (!m || init?.method !== "PUT") throw new Error(`unexpected fetch ${url}`);
    const part = Number(m[1]);
    const body = new Uint8Array(await (init.body as Blob).arrayBuffer());
    puts.push({ part, body });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (held) {
        const signal = init.signal!;
        await new Promise<void>((resolve, reject) => {
          held!.push(resolve);
          signal.addEventListener("abort", () => {
            abortedPuts++;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      const fail = failures[part]?.shift();
      if (fail) return new Response(null, { status: fail });
      return new Response(null, { status: 200, headers: opts.omitEtag ? {} : { etag: `"etag-${String(part)}"` } });
    } finally {
      inFlight--;
    }
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    calls,
    puts,
    /** Part numbers PUT, in order, including retries and aborted attempts. */
    putParts: () => puts.map((p) => p.part),
    actions: () => calls.map((c) => c.action),
    get maxInFlight() {
      return maxInFlight;
    },
    get abortedPuts() {
      return abortedPuts;
    },
    get heldCount() {
      return held?.length ?? 0;
    },
    /** From now on PUTs wait until `release()` (or until the uploader aborts them). */
    hold() {
      held = [];
    },
    release() {
      const h = held ?? [];
      held = undefined;
      h.forEach((r) => r());
    },
  };
}

/** A file of `size` bytes whose byte i is i % 251, so misplaced slices show. */
export function makeFile(size: number, name = "talk.mp4", lastModified = 1_700_000_000_000, type = "video/mp4"): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  return new File([bytes], name, { type, lastModified });
}

/** Resolves once `predicate` holds, polling the event loop. */
export async function until(predicate: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}
