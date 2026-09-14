/**
 * Byte uploader for hosted videos.
 *
 * The API hands out presigned S3 URLs but never touches the bytes itself, so
 * pushing a file at it is three steps: open an upload, PUT the bytes, tell the
 * API the bytes landed. This module does all three, picking a single PUT for a
 * file that fits in one part and an S3 multipart upload for anything larger.
 *
 * Everything here is plain `fetch` + Web Streams. `node:fs` is imported
 * dynamically and only when the caller passes a filesystem path, so a bundler
 * targeting the browser never pulls it in.
 */

import type { UploadPart, Video } from "./gen/transcodely/v1/video_pb.js";
import { UploadAbortedError, UploadError } from "./errors.js";

/** Smallest part S3 accepts, except for the final part (5 MiB). */
export const MIN_PART_SIZE = 5 * 1024 * 1024;

/** Part size used when the caller doesn't pick one (25 MiB — the API default). */
export const DEFAULT_PART_SIZE = 25 * 1024 * 1024;

/** S3's hard ceiling on parts per multipart upload. */
export const MAX_PARTS = 10_000;

/** Platform upload ceiling enforced by the API (5 GB). */
export const MAX_UPLOAD_SIZE_BYTES = 5_368_709_120;

/**
 * `filename` is `max_len: 255` on every create request (video.proto). A path
 * source can never exceed it — NAME_MAX is 255 — but a Blob or stream takes
 * whatever the caller passes, and a server-side validation error names a field
 * the caller never typed.
 */
export const MAX_FILENAME_LENGTH = 255;

/** Parts uploaded at once when the caller doesn't pick a number. */
export const DEFAULT_CONCURRENCY = 4;

/** Retries per part after the first attempt. */
export const DEFAULT_MAX_RETRIES = 4;

/** First backoff step; doubles per retry, jittered, capped at 10 s. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;

/** Part numbers the API accepts in one GetUploadPartUrls call. */
const URL_BATCH_SIZE = 100;

/**
 * Anything {@link Uploads.putFile} can read bytes from.
 *
 * - `string` — a filesystem path. Size and filename come from the path itself.
 * - `Blob` / `File` — size comes from the blob; a `File` also supplies the name.
 * - `ReadableStream<Uint8Array>` — you must pass `sizeBytes` and `filename`,
 *   because the API needs both before the first byte moves.
 */
export type UploadSource = string | Blob | ReadableStream<Uint8Array>;

/** Progress snapshot, reported once per completed part. */
export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  partsCompleted: number;
  totalParts: number;
  /** 0–100, rounded. */
  percent: number;
}

export interface PutFileOptions {
  /**
   * App the video is created under.
   *
   * The app does not have to have managed hosting turned on first: the create
   * call provisions the bucket, the managed origin and the CDN pull zone on an
   * app that has never hosted anything, which is why a first upload can take a
   * few seconds longer than the ones after it. If that provisioning fails the
   * request is refused with `hosting_provisioning_failed` and nothing is
   * created, so the same call is safe to retry. A refusal on billing or
   * admission grounds carries its own code instead (`billing_past_due`,
   * `outstanding_balance_exceeded`, `limit_exceeded`, `intake_paused`, …).
   */
  appId: string;
  /** Required for a `Blob` or stream; inferred from the path or `File.name` otherwise. */
  filename?: string;
  /** Inferred from the extension (or `Blob.type`) when omitted. */
  contentType?: string;
  /** Required for a `ReadableStream`; ignored for a path or blob. */
  sizeBytes?: number;

  title?: string;
  description?: string;
  tags?: string[];
  /** "public", "unlisted" or "private". Omit to take the app's default. */
  visibility?: string;
  /** Preset ID or slug driving the auto-transcode. */
  preset?: string;
  hoverPreviews?: boolean;
  autoCaptions?: boolean;

  /** Bytes per part. Clamped up to 5 MiB, and raised further if 10,000 parts would not cover the file. */
  partSize?: number;
  /** Parts in flight at once. Default 4. */
  concurrency?: number;
  /** Retries per part after the first attempt. Default 4. */
  maxRetries?: number;
  /** First backoff step in ms. Default 500. */
  retryBaseDelayMs?: number;
  /** Called after each part lands. Progress is per part, not per byte. */
  onProgress?: (progress: UploadProgress) => void;
  /** Abort the upload. In-flight parts are canceled and the multipart upload is aborted server-side. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Part size for a file: the requested size (or the default), never below the
 * 5 MiB S3 minimum, and raised as far as it takes to keep the part count
 * inside S3's 10,000-part ceiling.
 */
export function calculatePartSize(fileSize: number, requestedPartSize?: number): number {
  const requested = Math.max(requestedPartSize ?? DEFAULT_PART_SIZE, MIN_PART_SIZE);
  return Math.max(requested, Math.ceil(fileSize / MAX_PARTS));
}

/** Number of parts a file of `fileSize` splits into at `partSize`. */
export function calculateTotalParts(fileSize: number, partSize: number): number {
  return Math.max(1, Math.ceil(fileSize / partSize));
}

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  ts: "video/mp2t",
  m2ts: "video/mp2t",
  "3gp": "video/3gpp",
  ogv: "video/ogg",
};

/** Best-effort MIME type from a filename extension. */
export function contentTypeForFilename(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Presigned-URL resolution
// ---------------------------------------------------------------------------

export interface PartUrl {
  partNumber: number;
  uploadUrl: string;
}

export interface PartUrlResolver {
  /** Record URLs the API volunteered (CreateMultipartUpload returns the first 50). */
  seed(parts: readonly PartUrl[]): void;
  /** URL for a part, fetching a batch of up to 100 if it isn't cached. */
  get(partNumber: number): Promise<string>;
  /** Forget a URL the store rejected, so the next `get` re-signs it. */
  invalidate(partNumber: number): void;
}

/**
 * Lazily resolves presigned part URLs, batching misses into windows of 100 and
 * coalescing concurrent misses for the same window into one round trip. Lazy
 * rather than up-front because presigned URLs expire in about an hour, and a
 * large upload can outlive a batch signed at the start.
 */
export function resolvePartUrls(
  totalParts: number,
  fetchUrls: (partNumbers: number[]) => Promise<readonly PartUrl[]>,
): PartUrlResolver {
  const cache = new Map<number, string>();
  const inflight = new Map<number, Promise<void>>();

  return {
    seed(parts) {
      for (const p of parts) {
        if (p.uploadUrl) cache.set(p.partNumber, p.uploadUrl);
      }
    },
    invalidate(partNumber) {
      cache.delete(partNumber);
    },
    async get(partNumber) {
      const cached = cache.get(partNumber);
      if (cached !== undefined) return cached;

      const pending = inflight.get(partNumber);
      if (pending) {
        await pending;
        const settled = cache.get(partNumber);
        if (settled === undefined) {
          throw new UploadError({ message: `no presigned URL returned for part ${String(partNumber)}` });
        }
        return settled;
      }

      const window: number[] = [];
      for (let n = partNumber; n <= totalParts && window.length < URL_BATCH_SIZE; n++) {
        if (!cache.has(n) && !inflight.has(n)) window.push(n);
      }
      const task = (async () => {
        const parts = await fetchUrls(window);
        for (const p of parts) {
          if (p.uploadUrl) cache.set(p.partNumber, p.uploadUrl);
        }
      })();
      for (const n of window) inflight.set(n, task);
      try {
        await task;
      } finally {
        for (const n of window) inflight.delete(n);
      }
      const url = cache.get(partNumber);
      if (url === undefined) {
        throw new UploadError({ message: `no presigned URL returned for part ${String(partNumber)}` });
      }
      return url;
    },
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** One part's bytes, re-readable so a retry doesn't need the source again. */
interface PartPlan {
  partNumber: number;
  read(): Promise<Uint8Array>;
}

interface ResolvedSource {
  totalBytes: number;
  filename: string;
  contentType: string;
  /** Reads the whole source — only used on the single-PUT path. */
  readAll(): Promise<Uint8Array>;
  /** Yields parts in order; `undefined` ends the run. */
  nextPart(partSize: number, totalParts: number): Promise<PartPlan | undefined>;
  close(): Promise<void>;
}

function inferName(opts: PutFileOptions, fallback: string | undefined): string {
  const name = opts.filename ?? fallback;
  if (!name) {
    throw new UploadError({
      message:
        "filename is required for this source — pass `filename` (a path or a File supplies it automatically)",
    });
  }
  // protovalidate's `max_len` counts Unicode code points, so a surrogate pair
  // is one character to the server and two to `String.length`. Counting the
  // same way keeps the local refusal from firing early on an astral name.
  const codePoints = [...name].length;
  if (codePoints > MAX_FILENAME_LENGTH) {
    throw new UploadError({
      message: `filename is ${String(codePoints)} characters; the API accepts at most ${String(MAX_FILENAME_LENGTH)}`,
    });
  }
  return name;
}

async function resolveSource(source: UploadSource, opts: PutFileOptions): Promise<ResolvedSource> {
  if (typeof source === "string") return await pathSource(source, opts);
  if (isBlob(source)) return blobSource(source, opts);
  return streamSource(source, opts);
}

function isBlob(source: Blob | ReadableStream<Uint8Array>): source is Blob {
  return typeof Blob !== "undefined" && source instanceof Blob;
}

async function pathSource(path: string, opts: PutFileOptions): Promise<ResolvedSource> {
  const fs = await import("node:fs/promises");
  const nodePath = await import("node:path");
  const handle = await fs.open(path, "r");
  let stat;
  try {
    stat = await handle.stat();
  } catch (err) {
    await handle.close();
    throw err;
  }
  const totalBytes = stat.size;
  const filename = inferName(opts, nodePath.basename(path));
  let cursor = 0;

  async function readRange(start: number, length: number): Promise<Uint8Array> {
    const buf = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buf, read, length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    if (read !== length) {
      // The file shrank between stat() and now. Sending the short slice would
      // upload a corrupt video, and on the single-PUT path the presigned URL is
      // signed with the original ContentLength, so it would fail as an opaque
      // 403 instead. Say what actually happened.
      throw new UploadError({
        message: `${path} changed size while it was being uploaded: expected ${String(length)} bytes at offset ${String(start)}, read ${String(read)}`,
      });
    }
    return buf;
  }

  return {
    totalBytes,
    filename,
    contentType: opts.contentType ?? contentTypeForFilename(filename),
    readAll: () => readRange(0, totalBytes),
    nextPart: (partSize, totalParts) => {
      if (cursor >= totalParts) return Promise.resolve(undefined);
      const partNumber = ++cursor;
      const start = (partNumber - 1) * partSize;
      const length = Math.min(partSize, totalBytes - start);
      return Promise.resolve({ partNumber, read: () => readRange(start, length) });
    },
    close: () => handle.close(),
  };
}

function blobSource(blob: Blob, opts: PutFileOptions): ResolvedSource {
  const fileName = (blob as Blob & { name?: string }).name;
  const filename = inferName(opts, fileName);
  const totalBytes = blob.size;
  let cursor = 0;

  const slice = async (start: number, end: number): Promise<Uint8Array> =>
    new Uint8Array(await blob.slice(start, end).arrayBuffer());

  return {
    totalBytes,
    filename,
    contentType:
      opts.contentType ?? (blob.type || contentTypeForFilename(filename)),
    readAll: () => slice(0, totalBytes),
    nextPart: (partSize, totalParts) => {
      if (cursor >= totalParts) return Promise.resolve(undefined);
      const partNumber = ++cursor;
      const start = (partNumber - 1) * partSize;
      return Promise.resolve({
        partNumber,
        read: () => slice(start, Math.min(start + partSize, totalBytes)),
      });
    },
    close: () => Promise.resolve(),
  };
}

function streamSource(stream: ReadableStream<Uint8Array>, opts: PutFileOptions): ResolvedSource {
  if (opts.sizeBytes === undefined) {
    throw new UploadError({
      message:
        "sizeBytes is required when uploading from a ReadableStream — the API needs the total size before the first byte moves",
    });
  }
  const totalBytes = opts.sizeBytes;
  const filename = inferName(opts, undefined);
  const reader = stream.getReader();
  let carry: Uint8Array | undefined;
  let done = false;
  let consumed = 0;
  let cursor = 0;

  /** Pulls exactly `want` bytes, or fewer if the stream ends first. */
  async function pull(want: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let have = 0;
    while (have < want) {
      if (carry !== undefined) {
        const take = Math.min(want - have, carry.length);
        chunks.push(carry.subarray(0, take));
        have += take;
        carry = take === carry.length ? undefined : carry.subarray(take);
        continue;
      }
      if (done) break;
      const next = await reader.read();
      if (next.done) {
        done = true;
        break;
      }
      carry = next.value;
    }
    const out = new Uint8Array(have);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    consumed += have;
    return out;
  }

  function assertDeclaredSize(): void {
    if (consumed !== totalBytes) {
      throw new UploadError({
        message: `stream produced ${String(consumed)} bytes but the declared sizeBytes was ${String(totalBytes)}`,
      });
    }
  }

  return {
    totalBytes,
    filename,
    contentType: opts.contentType ?? contentTypeForFilename(filename),
    async readAll() {
      const body = await pull(totalBytes + 1);
      assertDeclaredSize();
      return body;
    },
    async nextPart(partSize, totalParts) {
      if (cursor >= totalParts) {
        // One more read proves the stream held no bytes past the declared size.
        if (!done) await pull(1);
        assertDeclaredSize();
        return undefined;
      }
      const partNumber = ++cursor;
      const want = Math.min(partSize, totalBytes - (partNumber - 1) * partSize);
      const body = await pull(want);
      if (body.length < want) assertDeclaredSize();
      return { partNumber, read: () => Promise.resolve(body) };
    },
    close: async () => {
      try {
        await reader.cancel();
      } catch {
        /* the stream is already finished or errored */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Part transfer
// ---------------------------------------------------------------------------

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && err.name === "AbortError";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadAbortedError({ message: "upload aborted" }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new UploadAbortedError({ message: "upload aborted" }));
      },
      { once: true },
    );
  });
}

/**
 * 5xx, 429 and 408 are worth another try. A 403 is too — but only on the
 * multipart path, where it means the presigned URL expired and can be
 * re-signed. The single PUT has no re-signer, so retrying it would just
 * re-send the whole file against the same dead URL four more times.
 */
export function isRetryableStatus(status: number, canResign: boolean): boolean {
  if (status === 403) return canResign;
  return status >= 500 || status === 429 || status === 408;
}

interface PutPartArgs {
  url: string;
  body: Uint8Array;
  contentType: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal | undefined;
}

/** PUTs one part (or the whole file) and returns the unquoted ETag. */
async function putBytes({ url, body, contentType, fetchImpl, signal }: PutPartArgs): Promise<string> {
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: body as unknown as BodyInit,
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw new UploadError({
      message:
        res.status === 403
          ? "the storage endpoint rejected the upload URL (HTTP 403) — it has expired, or the file changed size after the upload was opened"
          : `presigned PUT failed with HTTP ${String(res.status)}`,
      httpStatus: res.status,
    });
  }
  // Drain so the socket can be reused.
  await res.arrayBuffer().catch(() => undefined);
  const etag = res.headers.get("etag");
  if (!etag) {
    // Deliberately carries no httpStatus: the transfer succeeded (HTTP
    // ${res.status}), so this is a local fault in the response shape, and the
    // retry classifier must treat it as unretryable rather than re-sending the
    // bytes four more times to the same endpoint that just answered 2xx.
    throw new UploadError({
      message: `the storage endpoint accepted the part (HTTP ${String(res.status)}) but returned no ETag header — the upload cannot be completed without it`,
    });
  }
  return etag.replace(/"/g, "");
}

// ---------------------------------------------------------------------------
// The uploader
// ---------------------------------------------------------------------------

/** The subset of VideoService the uploader drives. Lets tests stand in a double. */
export interface UploadRpcClient {
  createUpload(req: {
    appId: string;
    filename: string;
    contentType: string;
    sizeBytes: bigint;
    title?: string;
    description?: string;
    tags?: string[];
    visibility?: string;
    preset?: string;
    hoverPreviews?: boolean;
    autoCaptions?: boolean;
  }): Promise<{ video?: Video; uploadUrl: string }>;
  completeUpload(req: { id: string }): Promise<{ video?: Video }>;
  createMultipartUpload(req: {
    appId: string;
    filename: string;
    contentType: string;
    sizeBytes: bigint;
    totalParts: number;
    partSizeBytes: bigint;
    title?: string;
    description?: string;
    tags?: string[];
    visibility?: string;
    preset?: string;
    hoverPreviews?: boolean;
    autoCaptions?: boolean;
  }): Promise<{ video?: Video; uploadId: string; parts: UploadPart[] }>;
  getUploadPartUrls(req: {
    id: string;
    uploadId: string;
    partNumbers: number[];
  }): Promise<{ parts: UploadPart[] }>;
  completeMultipartUpload(req: {
    id: string;
    uploadId: string;
    parts: { partNumber: number; etag: string }[];
  }): Promise<{ video?: Video }>;
  abortMultipartUpload(req: { id: string; uploadId: string }): Promise<unknown>;
}

/**
 * The upload state machine, decoupled from the transport so it can be driven
 * by a double in tests. `client.uploads` is the wired-up subclass in
 * `resources/uploads.ts`.
 *
 * The API's own transcode fires as soon as the upload is marked complete, so
 * the returned `Video` is already in `processing` — watch it with
 * `client.videos.watch(video.id)`.
 */
export class UploadEngine {
  constructor(
    private readonly rpc: UploadRpcClient,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /**
   * Upload a file and return the hosted video it created.
   *
   * A file that fits in one part goes up as a single PUT; anything larger uses
   * an S3 multipart upload with `concurrency` parts in flight, per-part retry
   * with jittered backoff, automatic re-signing when a presigned URL expires,
   * and a server-side abort if the upload can't finish.
   *
   * @example
   * ```ts
   * const video = await client.uploads.putFile("./talk.mp4", {
   *   appId: "app_k1l2m3n4o5",
   *   title: "Conference talk",
   *   onProgress: (p) => process.stdout.write(`\r${String(p.percent)}%`),
   * });
   * ```
   */
  async putFile(source: UploadSource, opts: PutFileOptions): Promise<Video> {
    const resolved = await resolveSource(source, opts);
    try {
      return await this.run(resolved, opts);
    } finally {
      await resolved.close();
    }
  }

  private async run(src: ResolvedSource, opts: PutFileOptions): Promise<Video> {
    const { totalBytes } = src;
    if (totalBytes <= 0) {
      throw new UploadError({ message: "refusing to upload an empty file (0 bytes)" });
    }
    if (totalBytes > MAX_UPLOAD_SIZE_BYTES) {
      throw new UploadError({
        message: `file is ${String(totalBytes)} bytes, over the 5 GB platform upload ceiling`,
      });
    }

    const partSize = calculatePartSize(totalBytes, opts.partSize);
    const totalParts = calculateTotalParts(totalBytes, partSize);
    const report = progressReporter(opts.onProgress, totalBytes, totalParts);
    report(0, 0);

    const meta = {
      appId: opts.appId,
      filename: src.filename,
      contentType: src.contentType,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
      ...(opts.visibility !== undefined ? { visibility: opts.visibility } : {}),
      ...(opts.preset !== undefined ? { preset: opts.preset } : {}),
      ...(opts.hoverPreviews !== undefined ? { hoverPreviews: opts.hoverPreviews } : {}),
      ...(opts.autoCaptions !== undefined ? { autoCaptions: opts.autoCaptions } : {}),
    };

    return totalParts === 1
      ? await this.single(src, opts, meta, report)
      : await this.multipart(src, opts, meta, partSize, totalParts, report);
  }

  private async single(
    src: ResolvedSource,
    opts: PutFileOptions,
    meta: Record<string, unknown>,
    report: (bytes: number, parts: number) => void,
  ): Promise<Video> {
    const body = await src.readAll();
    const created = await this.rpc.createUpload({
      ...(meta as { appId: string; filename: string; contentType: string }),
      sizeBytes: BigInt(src.totalBytes),
    });
    const videoId = created.video?.id;
    if (!videoId) {
      throw new UploadError({ message: "CreateUpload returned no video" });
    }
    await this.attempt(
      1,
      opts,
      () => Promise.resolve(created.uploadUrl),
      undefined,
      body,
      src.contentType,
    );
    report(src.totalBytes, 1);
    const done = await this.rpc.completeUpload({ id: videoId });
    return requireVideo(done.video, "CompleteUpload");
  }

  private async multipart(
    src: ResolvedSource,
    opts: PutFileOptions,
    meta: Record<string, unknown>,
    partSize: number,
    totalParts: number,
    report: (bytes: number, parts: number) => void,
  ): Promise<Video> {
    const started = await this.rpc.createMultipartUpload({
      ...(meta as { appId: string; filename: string; contentType: string }),
      sizeBytes: BigInt(src.totalBytes),
      totalParts,
      partSizeBytes: BigInt(partSize),
    });
    const videoId = started.video?.id;
    if (!videoId || !started.uploadId) {
      throw new UploadError({ message: "CreateMultipartUpload returned no video or upload ID" });
    }
    const uploadId = started.uploadId;

    const urls = resolvePartUrls(totalParts, async (partNumbers) => {
      const res = await this.rpc.getUploadPartUrls({ id: videoId, uploadId, partNumbers });
      return res.parts;
    });
    urls.seed(started.parts);

    const etags = new Map<number, string>();
    let uploadedBytes = 0;

    const takeNext = serialize(() => src.nextPart(partSize, totalParts));

    // Set by the first lane that fails, so the others stop taking new parts
    // instead of draining the whole file into a doomed upload.
    let stopped = false;

    const worker = async (): Promise<void> => {
      try {
        for (;;) {
          if (stopped) return;
          if (opts.signal?.aborted) throw new UploadAbortedError({ message: "upload aborted" });
          const plan = await takeNext();
          if (!plan) return;
          const body = await plan.read();
          const etag = await this.attempt(
            plan.partNumber,
            opts,
            () => urls.get(plan.partNumber),
            () => urls.invalidate(plan.partNumber),
            body,
            src.contentType,
          );
          etags.set(plan.partNumber, etag);
          uploadedBytes += body.length;
          report(uploadedBytes, etags.size);
        }
      } catch (err) {
        stopped = true;
        throw err;
      }
    };

    try {
      const lanes = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, totalParts));
      // allSettled, not all: `all` rejects on the first failure while the other
      // lanes are still PUTting, so the abort below would race parts that are
      // still in flight — and S3 can land one *after* an abort, recreating the
      // orphan the abort exists to prevent. Waiting for every lane to settle
      // also keeps the source open until nothing is reading it any more.
      const settled = await Promise.allSettled(
        Array.from({ length: lanes }, () => worker()),
      );
      const failure = settled.find((r) => r.status === "rejected");
      if (failure) throw (failure as PromiseRejectedResult).reason;

      const parts = [...etags.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([partNumber, etag]) => ({ partNumber, etag }));
      const done = await this.rpc.completeMultipartUpload({ id: videoId, uploadId, parts });
      return requireVideo(done.video, "CompleteMultipartUpload");
    } catch (err) {
      // Incomplete multipart uploads are billed storage until something aborts
      // them, and nothing server-side sweeps them — so always try. The complete
      // call is inside this try on purpose: an InvalidPart, a 5xx or a billing
      // refusal there would otherwise strand the upload forever.
      await this.rpc.abortMultipartUpload({ id: videoId, uploadId }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * One part, with retry/backoff. `invalidate` is what makes a 403 retryable:
   * pass it on the multipart path, where the URL can be re-signed, and omit it
   * for the single PUT, where there is nothing new to try.
   */
  private async attempt(
    partNumber: number,
    opts: PutFileOptions,
    url: () => Promise<string>,
    invalidate: (() => void) | undefined,
    body: Uint8Array,
    contentType: string,
  ): Promise<string> {
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const base = opts.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    let last: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (opts.signal?.aborted) throw new UploadAbortedError({ message: "upload aborted" });
      try {
        return await putBytes({
          url: await url(),
          body,
          contentType,
          fetchImpl: this.fetchImpl,
          ...(opts.signal ? { signal: opts.signal } : { signal: undefined }),
        });
      } catch (err) {
        if (isAbort(err, opts.signal)) throw new UploadAbortedError({ message: "upload aborted" });
        last = err;
        const status = err instanceof UploadError ? err.httpStatus : undefined;
        if (status === 403) invalidate?.();
        // A thrown UploadError with no status is a local problem (a missing
        // ETag, a file that changed size); a network failure arrives as
        // something else entirely, and is worth retrying.
        const retryable =
          status === undefined
            ? !(err instanceof UploadError)
            : isRetryableStatus(status, invalidate !== undefined);
        if (!retryable || attempt === maxRetries) break;
        await sleep(base * 2 ** attempt * (0.5 + Math.random() * 0.5), opts.signal);
      }
    }

    const detail = last instanceof Error ? last.message : String(last);
    throw new UploadError({
      message: `part ${String(partNumber)} failed to upload: ${detail}`,
      ...(last instanceof UploadError && last.httpStatus !== undefined
        ? { httpStatus: last.httpStatus }
        : {}),
      cause: last,
    });
  }
}

function requireVideo(video: Video | undefined, rpc: string): Video {
  if (!video) throw new UploadError({ message: `${rpc} returned no video` });
  return video;
}

function progressReporter(
  onProgress: ((p: UploadProgress) => void) | undefined,
  totalBytes: number,
  totalParts: number,
): (uploadedBytes: number, partsCompleted: number) => void {
  if (!onProgress) return () => undefined;
  return (uploadedBytes, partsCompleted) => {
    onProgress({
      uploadedBytes,
      totalBytes,
      partsCompleted,
      totalParts,
      percent: totalBytes === 0 ? 0 : Math.round((uploadedBytes / totalBytes) * 100),
    });
  };
}

/**
 * Serializes calls to a producer so concurrent upload lanes can't interleave
 * inside it — the stream source hands out parts in order and is not reentrant.
 */
function serialize<T>(producer: () => Promise<T>): () => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return () => {
    const next = chain.then(producer);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
