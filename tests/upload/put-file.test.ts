import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Transcodely } from "../../src/client.js";
import { UploadAbortedError, UploadError } from "../../src/errors.js";
import {
  DEFAULT_PART_SIZE,
  MIN_PART_SIZE,
  calculatePartSize,
  calculateTotalParts,
  isRetryableStatus,
  resolvePartUrls,
  type UploadProgress,
} from "../../src/upload.js";
import { startMockServer, type MockBehaviour, type MockServer } from "./mock-server.js";

const PART = MIN_PART_SIZE; // 5 MiB — the smallest part the API accepts.

let tmp: string;
let server: MockServer | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "transcodely-upload-"));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(tmp, { recursive: true, force: true });
});

/** A deterministic, byte-addressable pattern so a misordered part is visible. */
function pattern(size: number): Buffer {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + (i >> 8)) & 0xff;
  return buf;
}

async function fixture(name: string, size: number): Promise<{ path: string; bytes: Buffer }> {
  const bytes = pattern(size);
  const path = join(tmp, name);
  await writeFile(path, bytes);
  return { path, bytes };
}

/**
 * Blocks every PUT until `expected` of them are in flight at the same moment,
 * then lets them all through. Records the real peak, so the test can assert the
 * concurrency exactly rather than only bounding it from above. The deadline
 * keeps a serial uploader from hanging the suite — it just records a peak of 1.
 */
function concurrencyGate(expected: number, deadlineMs = 2000) {
  let inFlight = 0;
  let peak = 0;
  let open = (): void => undefined;
  const reached = new Promise<void>((resolve) => (open = resolve));
  return {
    get peak() {
      return peak;
    },
    onPut: async (): Promise<void> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (inFlight >= expected) open();
      await Promise.race([reached, new Promise((r) => setTimeout(r, deadlineMs))]);
      inFlight--;
    },
  };
}

async function client(behaviour: MockBehaviour = {}): Promise<Transcodely> {
  server = await startMockServer(behaviour);
  return new Transcodely({
    apiKey: "ak_test",
    baseUrl: server.baseUrl,
    maxRetries: 0,
  });
}

describe("part sizing", () => {
  it("defaults to 25 MiB and clamps a too-small request up to the 5 MiB S3 minimum", () => {
    expect(calculatePartSize(100 * 1024 * 1024)).toBe(DEFAULT_PART_SIZE);
    expect(calculatePartSize(100 * 1024 * 1024, 1024)).toBe(MIN_PART_SIZE);
  });

  it("grows the part size rather than exceeding the 10,000-part cap", () => {
    // The cap cannot bind below the 5 GB platform ceiling — 5 GB at the 5 MiB
    // minimum is 1024 parts — so this exercises the arithmetic above it.
    const sixtyGb = 60 * 1024 * 1024 * 1024;
    const size = calculatePartSize(sixtyGb, MIN_PART_SIZE);
    expect(size).toBeGreaterThan(MIN_PART_SIZE);
    expect(calculateTotalParts(sixtyGb, size)).toBeLessThanOrEqual(10_000);
  });

  it("leaves the 5 MiB minimum alone at the 5 GB ceiling", () => {
    const fiveGb = 5 * 1024 * 1024 * 1024;
    expect(calculatePartSize(fiveGb, MIN_PART_SIZE)).toBe(MIN_PART_SIZE);
    expect(calculateTotalParts(fiveGb, MIN_PART_SIZE)).toBe(1024);
  });

  it("counts a trailing short part", () => {
    expect(calculateTotalParts(PART * 2 + 1, PART)).toBe(3);
  });
});

describe("resolvePartUrls", () => {
  it("asks for at most 100 part numbers per call and caches what it got", async () => {
    const asked: number[][] = [];
    const resolver = resolvePartUrls(250, async (numbers) => {
      asked.push(numbers);
      return numbers.map((n) => ({ partNumber: n, uploadUrl: `https://s3.invalid/${String(n)}` }));
    });
    resolver.seed([{ partNumber: 1, uploadUrl: "https://s3.invalid/seeded-1" }]);

    expect(await resolver.get(1)).toBe("https://s3.invalid/seeded-1");
    expect(asked).toHaveLength(0);

    expect(await resolver.get(2)).toBe("https://s3.invalid/2");
    expect(asked).toEqual([Array.from({ length: 100 }, (_, i) => i + 2)]);

    // Everything in that window is now cached — no second round trip.
    expect(await resolver.get(101)).toBe("https://s3.invalid/101");
    expect(asked).toHaveLength(1);
  });

  it("coalesces concurrent misses for the same window into one call", async () => {
    let calls = 0;
    const resolver = resolvePartUrls(10, async (numbers) => {
      calls++;
      return numbers.map((n) => ({ partNumber: n, uploadUrl: `https://s3.invalid/${String(n)}` }));
    });
    const urls = await Promise.all([resolver.get(1), resolver.get(2), resolver.get(3)]);
    expect(urls).toEqual([
      "https://s3.invalid/1",
      "https://s3.invalid/2",
      "https://s3.invalid/3",
    ]);
    expect(calls).toBe(1);
  });

  it("re-fetches a part whose URL was invalidated", async () => {
    let issue = 0;
    const resolver = resolvePartUrls(4, async (numbers) => {
      issue++;
      return numbers.map((n) => ({
        partNumber: n,
        uploadUrl: `https://s3.invalid/${String(n)}?issue=${String(issue)}`,
      }));
    });
    expect(await resolver.get(2)).toBe("https://s3.invalid/2?issue=1");
    resolver.invalidate(2);
    expect(await resolver.get(2)).toBe("https://s3.invalid/2?issue=2");
  });
});

describe("putFile — single PUT (one part)", () => {
  it("creates the upload, PUTs the bytes, and completes it", async () => {
    const c = await client();
    const { path, bytes } = await fixture("clip.mp4", 1024 * 64);

    const video = await c.uploads.putFile(path, { appId: "app_k1l2m3n4o5", title: "Clip" });

    expect(video.status).toBe("processing");
    expect(server!.calls.map((c2) => c2.method)).toEqual(["CreateUpload", "CompleteUpload"]);

    const create = server!.calls[0]!.body;
    expect(create.app_id).toBe("app_k1l2m3n4o5");
    expect(create.filename).toBe("clip.mp4");
    expect(create.content_type).toBe("video/mp4");
    expect(Number(create.size_bytes)).toBe(bytes.length);
    expect(create.title).toBe("Clip");

    expect(server!.puts).toHaveLength(1);
    expect(server!.puts[0]!.body.equals(bytes)).toBe(true);
    expect(server!.puts[0]!.contentType).toBe("video/mp4");

    expect(server!.calls[1]!.body.id).toBe("vid_a1b2c3d4e5f6g7");
  });

  it("never opens a multipart upload for a file that fits in one part", async () => {
    const c = await client();
    const { path } = await fixture("tiny.mov", 4096);
    await c.uploads.putFile(path, { appId: "app_k1l2m3n4o5" });
    expect(server!.calls.some((c2) => c2.method.includes("Multipart"))).toBe(false);
  });
});

describe("putFile — multipart", () => {
  it("splits the file, uploads every part with its exact slice, and completes in part order", async () => {
    const c = await client();
    const size = PART * 2 + 1234;
    const { path, bytes } = await fixture("big.mp4", size);

    const video = await c.uploads.putFile(path, {
      appId: "app_k1l2m3n4o5",
      partSize: PART,
      concurrency: 3,
    });

    expect(video.status).toBe("processing");

    const create = server!.calls.find((c2) => c2.method === "CreateMultipartUpload")!.body;
    expect(create.total_parts).toBe(3);
    expect(Number(create.part_size_bytes)).toBe(PART);
    expect(Number(create.size_bytes)).toBe(size);

    expect(server!.puts).toHaveLength(3);
    for (const put of server!.puts) {
      const start = (put.partNumber - 1) * PART;
      const expected = bytes.subarray(start, Math.min(start + PART, size));
      expect(put.body.equals(expected)).toBe(true);
    }

    const complete = server!.calls.find((c2) => c2.method === "CompleteMultipartUpload")!.body;
    expect(complete.upload_id).toBe("s3-upload-id-0001");
    expect(complete.parts.map((p: any) => p.part_number)).toEqual([1, 2, 3]);
    // ETags are stored unquoted — S3 returns them wrapped in double quotes.
    for (const p of complete.parts) {
      expect(p.etag).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("uploads exactly `concurrency` parts at once — no more, and no fewer", async () => {
    // A one-sided bound (peak <= 2) is satisfied by a fully serial uploader, so
    // this gate holds every part until `concurrency` of them are genuinely in
    // flight together. A serial uploader never opens the gate and falls out on
    // the deadline with a peak of 1, which the exact assertion catches.
    const gate = concurrencyGate(2);
    const c = await client({ onPut: gate.onPut });
    const { path } = await fixture("big.mp4", PART * 4);
    await c.uploads.putFile(path, { appId: "app_k1l2m3n4o5", partSize: PART, concurrency: 2 });
    expect(server!.puts).toHaveLength(4);
    expect(gate.peak).toBe(2);
  });

  it("never opens more lanes than there are parts", async () => {
    const gate = concurrencyGate(2);
    const c = await client({ onPut: gate.onPut });
    const { path } = await fixture("big.mp4", PART * 2);
    await c.uploads.putFile(path, { appId: "app_k1l2m3n4o5", partSize: PART, concurrency: 8 });
    expect(gate.peak).toBe(2);
  });

  it("reports monotonic progress that ends at 100%", async () => {
    const c = await client();
    const size = PART * 2 + 10;
    const { path } = await fixture("big.mp4", size);
    const seen: UploadProgress[] = [];

    await c.uploads.putFile(path, {
      appId: "app_k1l2m3n4o5",
      partSize: PART,
      onProgress: (p) => seen.push({ ...p }),
    });

    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.uploadedBytes).toBeGreaterThanOrEqual(seen[i - 1]!.uploadedBytes);
    }
    const last = seen.at(-1)!;
    expect(last.totalBytes).toBe(size);
    expect(last.uploadedBytes).toBe(size);
    expect(last.partsCompleted).toBe(3);
    expect(last.totalParts).toBe(3);
    expect(last.percent).toBe(100);
  });
});

describe("putFile — retries and failures", () => {
  it("retries a part that answers 5xx and still completes", async () => {
    const c = await client({ failures: { 2: [500, 503] } });
    const { path } = await fixture("big.mp4", PART * 2);
    const video = await c.uploads.putFile(path, {
      appId: "app_k1l2m3n4o5",
      partSize: PART,
      retryBaseDelayMs: 1,
    });
    expect(video.status).toBe("processing");
    const part2 = server!.puts.filter((p) => p.partNumber === 2);
    expect(part2).toHaveLength(3);
    expect(server!.calls.some((c2) => c2.method === "AbortMultipartUpload")).toBe(false);
  });

  it("asks for a fresh presigned URL when a part answers 403", async () => {
    const c = await client({ failures: { 1: [403] } });
    const { path } = await fixture("big.mp4", PART * 2);
    await c.uploads.putFile(path, {
      appId: "app_k1l2m3n4o5",
      partSize: PART,
      retryBaseDelayMs: 1,
    });
    // Part 1 was issued a URL twice: once by CreateMultipartUpload, once by
    // the GetUploadPartUrls refresh the 403 forced.
    expect(server!.issuedUrls.get(1)).toHaveLength(2);
    const refresh = server!.calls.find((c2) => c2.method === "GetUploadPartUrls");
    expect(refresh!.body.part_numbers).toContain(1);
    const urls = server!.issuedUrls.get(1)!;
    expect(urls[0]).not.toBe(urls[1]);
  });

  it("gives up on a non-retryable 4xx and aborts the multipart upload", async () => {
    const c = await client({ failures: { 2: [400, 400, 400, 400, 400, 400] } });
    const { path } = await fixture("big.mp4", PART * 2);
    await expect(
      c.uploads.putFile(path, {
        appId: "app_k1l2m3n4o5",
        partSize: PART,
        retryBaseDelayMs: 1,
      }),
    ).rejects.toBeInstanceOf(UploadError);
    // One attempt only — 400 is not retried.
    expect(server!.puts.filter((p) => p.partNumber === 2)).toHaveLength(1);
    const abort = server!.calls.find((c2) => c2.method === "AbortMultipartUpload");
    expect(abort!.body.upload_id).toBe("s3-upload-id-0001");
  });

  it("stops after maxRetries and reports the part that failed", async () => {
    const c = await client({ failures: { 1: [500, 500, 500, 500, 500, 500] } });
    const { path } = await fixture("big.mp4", PART * 2);
    await expect(
      c.uploads.putFile(path, {
        appId: "app_k1l2m3n4o5",
        partSize: PART,
        maxRetries: 2,
        retryBaseDelayMs: 1,
      }),
    ).rejects.toThrow(/part 1/i);
    expect(server!.puts.filter((p) => p.partNumber === 1)).toHaveLength(3);
  });

  it("fails loudly when the store answers without an ETag", async () => {
    const c = await client({ omitEtagFor: [1] });
    const { path } = await fixture("big.mp4", PART * 2);
    await expect(
      c.uploads.putFile(path, {
        appId: "app_k1l2m3n4o5",
        partSize: PART,
        retryBaseDelayMs: 1,
      }),
    ).rejects.toThrow(/etag/i);
  });

  it("aborts the multipart upload when the caller's signal fires", async () => {
    const ac = new AbortController();
    const c = await client({
      onPut: (put) => {
        if (put.partNumber === 1) ac.abort();
      },
    });
    const { path } = await fixture("big.mp4", PART * 3);
    await expect(
      c.uploads.putFile(path, {
        appId: "app_k1l2m3n4o5",
        partSize: PART,
        concurrency: 1,
        retryBaseDelayMs: 1,
        signal: ac.signal,
      }),
    ).rejects.toBeInstanceOf(UploadAbortedError);
    expect(server!.calls.some((c2) => c2.method === "AbortMultipartUpload")).toBe(true);
    expect(server!.calls.some((c2) => c2.method === "CompleteMultipartUpload")).toBe(false);
  });

  it("does not swallow an API error from CreateMultipartUpload", async () => {
    const c = await client({
      rpcErrors: {
        CreateMultipartUpload: {
          status: 503,
          code: "hosting_provisioning_failed",
          message: "could not provision managed storage",
        },
      },
    });
    const { path } = await fixture("big.mp4", PART * 2);
    await expect(
      c.uploads.putFile(path, { appId: "app_k1l2m3n4o5", partSize: PART }),
    ).rejects.toThrow(/provision/i);
    expect(server!.puts).toHaveLength(0);
  });
});

describe("putFile — retry classification", () => {
  // The pure predicate, exhaustively. `canResign` is the multipart path, where
  // a 403 means the presigned URL expired and a fresh one can be signed.
  it.each([
    [400, false, false],
    [401, false, false],
    [404, false, false],
    [409, false, false],
    [422, false, false],
    [403, false, false],
    [403, true, true],
    [408, false, true],
    [429, false, true],
    [500, false, true],
    [502, false, true],
    [503, false, true],
  ])("HTTP %i with canResign=%s is retryable=%s", (status, canResign, expected) => {
    expect(isRetryableStatus(status, canResign)).toBe(expected);
  });

  // And the same contract observed end to end, counting real PUTs.
  it.each([
    [400, 1],
    [401, 1],
    [404, 1],
    [409, 1],
    [403, 3],
    [408, 3],
    [429, 3],
    [500, 3],
    [503, 3],
  ])("a multipart part answering %i is attempted %i time(s)", async (status, attempts) => {
    const c = await client({ failures: { 1: Array.from({ length: 8 }, () => status) } });
    const { path } = await fixture("big.mp4", PART * 2);
    await expect(
      c.uploads.putFile(path, {
        appId: "app_k1l2m3n4o5",
        partSize: PART,
        concurrency: 1,
        maxRetries: 2,
        retryBaseDelayMs: 1,
      }),
    ).rejects.toBeInstanceOf(UploadError);
    expect(server!.puts.filter((p) => p.partNumber === 1)).toHaveLength(attempts);
  });

  it("does not retry a single PUT that answers 403 — there is no URL to re-sign", async () => {
    const c = await client({ failures: { 0: [403, 403, 403, 403, 403] } });
    const { path } = await fixture("small.mp4", 4096);
    await expect(
      c.uploads.putFile(path, { appId: "app_k1l2m3n4o5", retryBaseDelayMs: 1 }),
    ).rejects.toThrow(/expired, or the file changed size/);
    expect(server!.puts).toHaveLength(1);
  });

  it("attempts a part exactly once when the store returns no ETag", async () => {
    const c = await client({ omitEtagFor: [1] });
    const { path } = await fixture("big.mp4", PART * 2);
    await expect(
      c.uploads.putFile(path, {
        appId: "app_k1l2m3n4o5",
        partSize: PART,
        concurrency: 1,
        retryBaseDelayMs: 1,
      }),
    ).rejects.toThrow(/etag/i);
    expect(server!.puts.filter((p) => p.partNumber === 1)).toHaveLength(1);
  });

  it("does not retry when the API hands back no URL for a part", async () => {
    const c = await client({ emptyPartUrlsFor: [2] });
    const { path } = await fixture("big.mp4", PART * 2);
    await expect(
      c.uploads.putFile(path, {
        appId: "app_k1l2m3n4o5",
        partSize: PART,
        concurrency: 1,
        retryBaseDelayMs: 1,
      }),
    ).rejects.toThrow(/no presigned URL/);
    expect(server!.puts.map((p) => p.partNumber)).toEqual([1]);
    expect(server!.calls.filter((c2) => c2.method === "GetUploadPartUrls")).toHaveLength(1);
  });

  it("retries a socket-level failure, which never carries a status at all", async () => {
    // The retry classifier treats "no HTTP status" as retryable unless it is a
    // local UploadError. Prove it with a fetch that dies on the wire the first
    // time each part is PUT, the way a dropped connection does.
    const failedOnce = new Set<string>();
    server = await startMockServer();
    const wire: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (init?.method === "PUT" && !failedOnce.has(url)) {
        failedOnce.add(url);
        throw new TypeError("fetch failed");
      }
      return await fetch(input as RequestInfo, init);
    };
    const c = new Transcodely({
      apiKey: "ak_test",
      baseUrl: server.baseUrl,
      maxRetries: 0,
      fetchImpl: wire,
    });
    const { path } = await fixture("big.mp4", PART * 2);
    const video = await c.uploads.putFile(path, {
      appId: "app_k1l2m3n4o5",
      partSize: PART,
      concurrency: 1,
      retryBaseDelayMs: 1,
    });
    expect(video.status).toBe("processing");
    expect(failedOnce.size).toBe(2);
    // Both parts still landed: the retry re-read the slice and sent it again.
    expect(server.puts.map((p) => p.partNumber).sort()).toEqual([1, 2]);
  });
});

describe("putFile — abort on every failure path", () => {
  it("aborts the multipart upload when CompleteMultipartUpload itself fails", async () => {
    const c = await client({
      rpcErrors: {
        CompleteMultipartUpload: {
          status: 500,
          code: "internal",
          message: "could not assemble the parts",
        },
      },
    });
    const { path } = await fixture("big.mp4", PART * 2);
    await expect(
      c.uploads.putFile(path, { appId: "app_k1l2m3n4o5", partSize: PART }),
    ).rejects.toThrow(/assemble/);
    // Every part landed, so without this the upload would sit in the bucket
    // forever: nothing server-side sweeps incomplete multipart uploads.
    expect(server!.puts).toHaveLength(2);
    const abort = server!.calls.find((c2) => c2.method === "AbortMultipartUpload");
    expect(abort!.body.upload_id).toBe("s3-upload-id-0001");
  });

  it("lets every lane settle before aborting, so no part is still in flight", async () => {
    const c = await client({
      failures: { 2: [400] },
      onPut: async () => {
        // Wide enough that a `Promise.all` would fire the abort while the
        // other three lanes were still mid-PUT.
        await new Promise((r) => setTimeout(r, 40));
      },
    });
    const { path } = await fixture("big.mp4", PART * 4);
    await expect(
      c.uploads.putFile(path, {
        appId: "app_k1l2m3n4o5",
        partSize: PART,
        concurrency: 4,
        retryBaseDelayMs: 1,
      }),
    ).rejects.toBeInstanceOf(UploadError);

    const abortAt = server!.timeline.indexOf("rpc:AbortMultipartUpload");
    expect(abortAt).toBeGreaterThan(-1);
    expect(server!.timeline.slice(abortAt).filter((e) => e.startsWith("put:"))).toEqual([]);
  });

  it("stops handing out parts once a lane has failed", async () => {
    const c = await client({ failures: { 1: [400] } });
    const { path } = await fixture("big.mp4", PART * 6);
    await expect(
      c.uploads.putFile(path, {
        appId: "app_k1l2m3n4o5",
        partSize: PART,
        concurrency: 1,
        retryBaseDelayMs: 1,
      }),
    ).rejects.toBeInstanceOf(UploadError);
    // The single lane failed on part 1 and never went on to 2..6.
    expect(server!.puts.map((p) => p.partNumber)).toEqual([1]);
  });
});

describe("putFile — the file changing underneath it", () => {
  it("refuses to upload a short part when the file shrinks mid-upload", async () => {
    let path = "";
    const c = await client({
      onPut: async (put) => {
        // Truncate after the first part has been read and sent, so part 2's
        // read comes up short deterministically.
        if (put.partNumber === 1) await truncate(path, PART);
      },
    });
    ({ path } = await fixture("big.mp4", PART * 3));
    await expect(
      c.uploads.putFile(path, {
        appId: "app_k1l2m3n4o5",
        partSize: PART,
        concurrency: 1,
        retryBaseDelayMs: 1,
      }),
    ).rejects.toThrow(/changed size/);
    expect(server!.calls.some((c2) => c2.method === "AbortMultipartUpload")).toBe(true);
  });
});

describe("putFile — sources other than a path", () => {
  it("accepts a Blob, taking the filename from the options", async () => {
    const c = await client();
    const bytes = pattern(PART * 2);
    const blob = new Blob([bytes], { type: "video/webm" });
    await c.uploads.putFile(blob, {
      appId: "app_k1l2m3n4o5",
      filename: "from-blob.webm",
      partSize: PART,
    });
    const create = server!.calls.find((c2) => c2.method === "CreateMultipartUpload")!.body;
    expect(create.filename).toBe("from-blob.webm");
    expect(create.content_type).toBe("video/webm");
    expect(server!.puts).toHaveLength(2);
  });

  it("accepts a ReadableStream when the size is declared", async () => {
    const c = await client();
    const bytes = pattern(PART + 512);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Deliberately chunked on a boundary that does not line up with parts.
        for (let off = 0; off < bytes.length; off += 100_000) {
          controller.enqueue(new Uint8Array(bytes.subarray(off, off + 100_000)));
        }
        controller.close();
      },
    });
    await c.uploads.putFile(stream, {
      appId: "app_k1l2m3n4o5",
      filename: "stream.mp4",
      sizeBytes: bytes.length,
      partSize: PART,
      concurrency: 2,
    });
    expect(server!.puts).toHaveLength(2);
    const byPart = new Map(server!.puts.map((p) => [p.partNumber, p.body]));
    expect(byPart.get(1)!.equals(bytes.subarray(0, PART))).toBe(true);
    expect(byPart.get(2)!.equals(bytes.subarray(PART))).toBe(true);
  });

  it("retries a stream-sourced part from the buffer, without re-reading the stream", async () => {
    const c = await client({ failures: { 1: [500, 503] } });
    const bytes = pattern(PART * 2);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let off = 0; off < bytes.length; off += 250_000) {
          pulls++;
          controller.enqueue(new Uint8Array(bytes.subarray(off, off + 250_000)));
        }
        controller.close();
      },
    });
    await c.uploads.putFile(stream, {
      appId: "app_k1l2m3n4o5",
      filename: "stream.mp4",
      sizeBytes: bytes.length,
      partSize: PART,
      concurrency: 1,
      retryBaseDelayMs: 1,
    });
    const part1 = server!.puts.filter((p) => p.partNumber === 1);
    expect(part1).toHaveLength(3);
    // Every attempt sent the identical bytes, and the stream was enqueued once.
    for (const put of part1) expect(put.body.equals(bytes.subarray(0, PART))).toBe(true);
    expect(pulls).toBe(Math.ceil(bytes.length / 250_000));
  });

  it("refuses a ReadableStream with no declared size", async () => {
    const c = await client();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    await expect(
      c.uploads.putFile(stream, { appId: "app_k1l2m3n4o5", filename: "x.mp4" }),
    ).rejects.toThrow(/sizeBytes/);
    expect(server!.calls).toHaveLength(0);
  });

  it("refuses a stream whose real length disagrees with the declared size", async () => {
    const c = await client();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.close();
      },
    });
    await expect(
      c.uploads.putFile(stream, {
        appId: "app_k1l2m3n4o5",
        filename: "x.mp4",
        sizeBytes: 4096,
        retryBaseDelayMs: 1,
      }),
    ).rejects.toThrow(/declared/i);
  });
});

describe("putFile — input validation", () => {
  it("refuses an empty file before touching the API", async () => {
    const c = await client();
    const { path } = await fixture("empty.mp4", 0);
    await expect(c.uploads.putFile(path, { appId: "app_k1l2m3n4o5" })).rejects.toThrow(/empty/i);
    expect(server!.calls).toHaveLength(0);
  });

  it("refuses a file over the 5 GB platform ceiling before touching the API", async () => {
    const c = await client();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    await expect(
      c.uploads.putFile(stream, {
        appId: "app_k1l2m3n4o5",
        filename: "huge.mp4",
        sizeBytes: 5 * 1024 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow(/5 GB/);
    expect(server!.calls).toHaveLength(0);
  });

  it("refuses a filename longer than the API's 255-character limit", async () => {
    const c = await client();
    const blob = new Blob([pattern(1024)]);
    await expect(
      c.uploads.putFile(blob, { appId: "app_k1l2m3n4o5", filename: `${"a".repeat(256)}.mp4` }),
    ).rejects.toThrow(/255/);
    expect(server!.calls).toHaveLength(0);
  });

  it("requires a filename it cannot infer", async () => {
    const c = await client();
    const blob = new Blob([pattern(1024)]);
    await expect(c.uploads.putFile(blob, { appId: "app_k1l2m3n4o5" })).rejects.toThrow(/filename/);
  });
});
