/**
 * The browser uploader. It never holds an API key: your backend's upload
 * handler opens the multipart upload and signs part URLs, and this pushes the
 * bytes straight to storage, remembering each finished part so a reload, a
 * dropped connection or a pause picks up where it stopped.
 *
 * Nothing here touches `window`, `navigator`, `indexedDB` or `crypto` until an
 * upload starts, so importing it during server rendering is safe.
 */

import type {
  CompleteUploadResponse,
  CreateUploadResponse,
  SignPartsResponse,
  UploadRequest,
  WirePartUrl,
} from "./protocol.js";
import { MAX_FILE_SIZE, TranscodelyUploadError as E, acceptsFile, formatBytes, partsFor } from "./shared.js";
import { indexedDBStore, type UploadRecord, type UploadStore } from "./store.js";

export type UploadState =
  | "idle"
  | "preparing"
  | "uploading"
  | "paused"
  | "offline"
  | "completing"
  | "success"
  | "error"
  | "canceled";

export interface UploadProgress {
  loaded: number;
  total: number;
  /** 0 to 100, rounded down. Counts bytes still in flight, so 100 can show just before the last part is confirmed. */
  percent: number;
}

export interface UploadResult {
  videoId: string;
  /** The video's status after the upload completed, usually `processing`. */
  status: string;
  /** True when this upload continued one an earlier page started. */
  resumed: boolean;
}

export interface CreateUploadOptions {
  /** Your upload handler's URL, for example `/api/transcodely/upload`. */
  endpoint: string;
  /** Extra headers for endpoint calls (never sent to storage), or a function returning them. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Default `"same-origin"`. */
  credentials?: RequestCredentials;
  metadata?: { title?: string; description?: string };
  /** Checked before anything is sent; the handler checks again. Same syntax as `<input accept>`. */
  accept?: string;
  /** Checked before anything is sent; the handler checks again. Capped at 5 GiB. */
  maxFileSize?: number;
  /** Parts in flight at once. Default 3, between 1 and 6. */
  concurrency?: number;
  /**
   * Retries per part and per endpoint call, after network errors, 5xx, 408 and
   * 429. Default 5. `create` is never retried on an answer or a network error:
   * it opens a new video, a retry after a lost answer could open a second one,
   * and a 429 there is usually a spend or queue limit that waiting will not
   * lift. It only waits while the browser is offline. Time spent paused or
   * offline does not use up retries.
   */
  retries?: number;
  /** First backoff step in ms; doubles per retry with jitter, capped at 30 s. Default 1000. */
  retryDelayMs?: number;
  /** Where unfinished uploads are remembered. Default `indexedDBStore()`; `false` turns resume off. */
  store?: UploadStore | false;
  /** Used for endpoint calls, and for part PUTs where `XMLHttpRequest` is missing. */
  fetch?: typeof fetch;
  onProgress?: (progress: UploadProgress) => void;
  onStateChange?: (state: UploadState) => void;
}

export interface Upload {
  readonly state: UploadState;
  readonly progress: UploadProgress;
  readonly error: E | undefined;
  readonly videoId: string | undefined;
  /** Starts, or returns the running attempt. After an error, starts again and resumes. */
  start(): Promise<UploadResult>;
  /** Stops sending; parts already in storage are kept. */
  pause(): void;
  resume(): void;
  /** Stops, aborts the multipart upload and forgets it. Cannot undo a completed upload. */
  cancel(): Promise<void>;
  /** Called on every state, progress or video id change. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** A part PUT with no upload progress for this long is abandoned and retried. */
const STALL = 60_000;
/** A record counts as gone this long before its ticket expires. */
const EXPIRY_MARGIN = 600_000;
/** Bytes hashed from each end of the file for the fingerprint. */
const SAMPLE = 65_536;
const STATUS_CODES: Record<number, string> = {
  401: "unauthenticated",
  403: "forbidden",
  410: "upload_expired",
  413: "file_too_large",
  415: "file_type_not_accepted",
};

const retryable = (s: number) => s >= 500 || s === 408 || s === 429;
const aborted = () => new E("aborted", "The upload was canceled.");

/** Uploads one file through your upload handler. Call `start()` to begin. */
export function createUpload(file: File, o: CreateUploadOptions): Upload {
  const f: typeof fetch = o.fetch ?? ((...a) => fetch(...a));
  const store = o.store === false ? undefined : (o.store ?? indexedDBStore());
  const retries = o.retries ?? 5;
  const lanes = Math.min(6, Math.max(1, o.concurrency ?? 3));
  const listeners = new Set<() => void>();
  const inflight = new Map<number, { c: AbortController; n: number }>();
  const wakers: (() => void)[] = [];

  let state: UploadState = "idle";
  let progress: UploadProgress = { loaded: 0, total: file.size, percent: 0 };
  let error: E | undefined;
  let videoId: string | undefined;
  let run: Promise<UploadResult> | undefined;
  let phase: UploadState = "preparing";
  let halted: "paused" | "offline" | undefined;
  let canceled = false;
  let completing = false;
  let cur: UploadRecord | undefined;

  const notify = () => listeners.forEach((l) => l());
  const set = (s: UploadState) => {
    if (s === state) return;
    state = s;
    o.onStateChange?.(s);
    notify();
  };
  const report = (loaded: number) => {
    if (loaded === progress.loaded) return;
    progress = { loaded, total: file.size, percent: Math.floor((loaded * 100) / file.size) };
    o.onProgress?.(progress);
    notify();
  };
  const wake = () => wakers.splice(0).forEach((w) => w());
  /** Sleeps `ms`, or until woken by resume, online or cancel; no `ms` waits only for that. */
  const wait = (ms?: number) =>
    new Promise<void>((r) => {
      const t = ms === undefined ? undefined : setTimeout(r, ms);
      wakers.push(() => (clearTimeout(t), r()));
    });
  const delay = (i: number) =>
    Math.min(30_000, (o.retryDelayMs ?? 1000) * 2 ** i) * (0.5 + Math.random() / 2);
  const offlineNow = () => typeof navigator !== "undefined" && navigator.onLine === false;
  const halt = (s: "paused" | "offline") => {
    if (completing || canceled || !(state === phase || state === "paused" || state === "offline")) return;
    halted = s;
    inflight.forEach((x) => x.c.abort());
    set(s);
  };
  const go = () => {
    halted = undefined;
    set(phase);
    wake();
  };
  /** Waits while paused or offline (until `online`, or every 2 s while finishing). */
  const hold = async () => {
    while (!canceled) {
      if (offlineNow() && !halted) halt("offline");
      if (!(halted || offlineNow())) return;
      await wait(2000);
    }
  };
  const save = async (r: UploadRecord) => {
    await store?.set(r.key, r).catch(() => undefined);
  };
  const drop = async (key: string) => {
    await store?.delete(key).catch(() => undefined);
  };

  /** One endpoint call; `last` is the best-effort abort sent while canceling. */
  const call = async <T>(body: UploadRequest, last = false): Promise<T> => {
    for (let i = 0; ; ) {
      if (!last) {
        await hold();
        if (canceled) throw aborted();
      }
      const h = typeof o.headers === "function" ? await o.headers() : o.headers;
      let err: E;
      try {
        const res = await f(o.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...h },
          credentials: o.credentials ?? "same-origin",
          body: JSON.stringify(body),
        });
        const j = (await res.json().catch(() => undefined)) as
          | { error?: { code?: unknown; message?: unknown } }
          | undefined;
        if (res.ok && j && typeof j === "object") return j as T;
        const w = res.ok ? undefined : j?.error;
        err = res.ok
          ? new E("bad_response", "The upload endpoint did not answer with JSON. Check that the endpoint URL points at your upload handler.", res.status)
          : new E(
              typeof w?.code === "string" ? w.code : (STATUS_CODES[res.status] ?? "bad_response"),
              typeof w?.message === "string" ? w.message : `The upload endpoint answered HTTP ${String(res.status)}.`,
              res.status,
              retryable(res.status),
            );
      } catch {
        err = new E("network", "Could not reach the upload endpoint. Check your connection and try again.", undefined, true);
      }
      // An attempt made while the browser is offline does not count.
      if (err.retryable && !last && offlineNow()) continue;
      if (!err.retryable || last || i >= retries || canceled || body.action === "create") {
        throw err;
      }
      await wait(delay(i++));
    }
  };

  /** PUTs one part to storage and returns its ETag. XHR where available, for byte progress. */
  const put = async (url: string, body: Blob, signal: AbortSignal, onBytes: (n: number) => void) => {
    let status: number;
    let etag: string | null;
    // A stalled connection often never errors: abort it when XHR reports no
    // progress for a minute, or when fetch takes longer than 8 KB/s would.
    const c = new AbortController();
    const kill = () => c.abort();
    let t: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms = STALL) => {
      clearTimeout(t);
      t = setTimeout(kill, ms);
    };
    signal.addEventListener("abort", kill);
    try {
      ({ status, etag } = await (typeof XMLHttpRequest !== "undefined"
        ? new Promise<{ status: number; etag: string | null }>((ok, no) => {
            const x = new XMLHttpRequest();
            x.open("PUT", url);
            x.upload.onprogress = (e) => (arm(), onBytes(e.loaded));
            x.onload = () => ok({ status: x.status, etag: x.getResponseHeader("ETag") });
            x.onerror = x.onabort = x.ontimeout = no;
            c.signal.addEventListener("abort", () => x.abort());
            arm();
            x.send(body);
          })
        : (arm(STALL + body.size / 8),
          f(url, { method: "PUT", body, signal: c.signal }).then((r) => ({ status: r.status, etag: r.headers.get("etag") })))));
    } catch {
      throw new E("network", "The connection to storage was lost. Check your connection and try again.", undefined, true);
    } finally {
      clearTimeout(t);
      signal.removeEventListener("abort", kill);
    }
    if (status < 200 || status > 299) {
      throw new E("storage_error", `Storage refused a part (HTTP ${String(status)}).`, status, status === 403 || retryable(status));
    }
    if (!etag) {
      throw new E("storage_error", "Storage accepted a part but did not expose its ETag header, so the upload cannot be completed. Add ETag to the bucket's CORS ExposeHeaders.", status);
    }
    return etag.replace(/"/g, "");
  };

  const fingerprint = async () => {
    let sample = "";
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const bytes = await new Blob([file.slice(0, SAMPLE), file.slice(-SAMPLE)]).arrayBuffer();
      sample = [...new Uint8Array(await subtle.digest("SHA-256", bytes))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    return [o.endpoint, file.name, file.size, file.lastModified, sample].join("|");
  };

  /** Whether a record describes this file the way the handler would slice it. */
  const fits = (r: UploadRecord, key: string) =>
    r.v === 1 && r.key === key && r.size === file.size && r.partSize > 0 &&
    r.totalParts === partsFor(file.size, r.partSize) && typeof r.ticket === "string" && !!r.parts;

  const transfer = async (key: string, rec?: UploadRecord) => {
    const urls = new Map<number, [string, number]>();
    const signing = new Map<number, Promise<void>>();
    const seed = (ps: WirePartUrl[] | undefined, exp: string) => {
      const t = Date.parse(exp) || Date.now() + 3_000_000;
      for (const p of ps ?? []) urls.set(p.part_number, [p.url, t]);
    };
    const fresh = (n: number) => (urls.get(n)?.[1] ?? 0) > Date.now() + 60_000;

    if (!rec) {
      const r = await call<CreateUploadResponse>({
        action: "create",
        file: { name: file.name, size: file.size, type: file.type, last_modified: file.lastModified },
        ...(o.metadata ? { metadata: o.metadata } : {}),
      });
      rec = cur = {
        v: 1, key, ticket: r.ticket, videoId: r.video_id, uploadId: r.upload_id, partSize: r.part_size,
        totalParts: r.total_parts, size: file.size, createdAt: Date.now(), expiresAt: Date.parse(r.expires_at), parts: {},
      };
      if (canceled) throw aborted();
      if (!fits(rec, key)) {
        throw new E("bad_response", "The upload endpoint opened an upload that does not match this file. Check that it uses createUploadHandler.");
      }
      seed(r.parts, r.urls_expire_at);
      await save(rec);
    }
    const r = (cur = rec);
    videoId = r.videoId;
    phase = "uploading";
    if (!halted) set(phase);
    notify();

    const len = (n: number) => Math.min(r.partSize, file.size - (n - 1) * r.partSize);
    const queue: number[] = [];
    let done = 0;
    for (let n = 1; n <= r.totalParts; n++) {
      if (r.parts[n]) done += len(n);
      else queue.push(n);
    }
    const tick = () => {
      let b = done;
      inflight.forEach((x) => (b += x.n));
      report(Math.min(b, file.size));
    };
    tick();

    /** A part's URL, signing a batch of up to 100 missing parts on a miss. */
    const url = async (n: number) => {
      if (!fresh(n)) {
        let p = signing.get(n);
        if (!p) {
          const batch: number[] = [];
          for (let m = n; m <= r.totalParts && batch.length < 100; m++) {
            if (!r.parts[m] && !signing.has(m) && !fresh(m)) batch.push(m);
          }
          p = call<SignPartsResponse>({ action: "sign_parts", ticket: r.ticket, part_numbers: batch }).then(
            (s) => seed(s.parts, s.urls_expire_at),
          );
          const q = p;
          batch.forEach((m) => signing.set(m, q));
          p.then(
            () => batch.forEach((m) => signing.delete(m)),
            () => batch.forEach((m) => signing.delete(m)),
          );
        }
        await p;
      }
      const u = urls.get(n);
      if (!u) throw new E("bad_response", `The upload endpoint returned no address for part ${String(n)}.`);
      return u[0];
    };

    let failed: unknown;
    const part = async (n: number) => {
      for (let i = 0; ; ) {
        await hold();
        if (canceled) throw aborted();
        if (failed) throw failed;
        const href = await url(n);
        if (halted || canceled) continue;
        const slot = { c: new AbortController(), n: 0 };
        inflight.set(n, slot);
        try {
          const etag = await put(href, file.slice((n - 1) * r.partSize, (n - 1) * r.partSize + len(n)), slot.c.signal, (b) => {
            slot.n = b;
            tick();
          });
          r.parts[n] = etag;
          await save(r);
          done += len(n);
          return;
        } catch (e) {
          // Aborted by pause, offline or another part failing: not an attempt.
          if (canceled || slot.c.signal.aborted) continue;
          const err = e as E;
          if (err.status === 403) urls.delete(n);
          if (!err.retryable) throw err;
          if (offlineNow()) continue;
          if (i >= retries) throw err;
          await wait(delay(i++));
        } finally {
          inflight.delete(n);
          tick();
        }
      }
    };
    const lane = async () => {
      try {
        for (let n = queue.shift(); n !== undefined; n = queue.shift()) await part(n);
      } catch (e) {
        failed ??= e;
        inflight.forEach((x) => x.c.abort());
        wake();
        throw e;
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(lanes, queue.length) }, lane));
    if (canceled) throw aborted();
    if (failed) throw failed;

    completing = true;
    set((phase = "completing"));
    try {
      const parts = Object.keys(r.parts).map((k) => ({ part_number: +k, etag: r.parts[+k]! }));
      const res = await call<CompleteUploadResponse>({ action: "complete", ticket: r.ticket, parts });
      await drop(key);
      return res;
    } finally {
      completing = false;
    }
  };

  const attempt = async (): Promise<UploadResult> => {
    error = undefined;
    halted = undefined;
    phase = "preparing";
    set(phase);
    const win = typeof window !== "undefined" && "addEventListener" in window ? window : undefined;
    const off = () => halted !== "paused" && halt("offline");
    const on = () => (halted === "offline" ? go() : wake());
    win?.addEventListener("offline", off);
    win?.addEventListener("online", on);
    let key = "";
    try {
      if (!file.size) throw new E("file_empty", "This file is empty. Choose a file that has content.");
      const max = Math.min(o.maxFileSize ?? MAX_FILE_SIZE, MAX_FILE_SIZE);
      if (file.size > max) {
        throw new E("file_too_large", `This file is ${formatBytes(file.size)}. The largest file you can upload is ${formatBytes(max)}.`);
      }
      if (!acceptsFile(file, o.accept)) {
        throw new E("file_type_not_accepted", `${file.name} is not a type of file this uploader accepts (${String(o.accept)}).`);
      }
      key = await fingerprint();
      let rec = await store?.get(key).catch(() => undefined);
      if (rec && !(fits(rec, key) && Date.now() < rec.expiresAt - EXPIRY_MARGIN)) {
        await drop(key);
        rec = undefined;
      }
      let resumed = !!rec;
      let res: CompleteUploadResponse;
      try {
        res = await transfer(key, rec);
      } catch (e) {
        const code = (e as E).code;
        if (!resumed || canceled || (code !== "upload_expired" && code !== "ticket_invalid")) throw e;
        // The handler no longer honours the old ticket: start over, once.
        await drop(key);
        resumed = false;
        progress = { loaded: 0, total: file.size, percent: 0 };
        res = await transfer(key);
      }
      report(file.size);
      set("success");
      return { videoId: res.video_id || cur!.videoId, status: res.status, resumed };
    } catch (e) {
      if (canceled) {
        if (cur) await call({ action: "abort", ticket: cur.ticket }, true).catch(() => undefined);
        await drop(key);
        set("canceled");
        throw aborted();
      }
      error = e instanceof E ? e : new E("unexpected", `The upload failed unexpectedly: ${String((e as Error)?.message ?? e)}`);
      if (error.code === "upload_expired" || error.code === "ticket_invalid") await drop(key);
      set("error");
      throw error;
    } finally {
      win?.removeEventListener("offline", off);
      win?.removeEventListener("online", on);
    }
  };

  return {
    get state() {
      return state;
    },
    get progress() {
      return progress;
    },
    get error() {
      return error;
    },
    get videoId() {
      return videoId;
    },
    start() {
      if (run && state !== "error") return run;
      run = attempt();
      run.catch(() => undefined);
      return run;
    },
    pause: () => halt("paused"),
    resume() {
      if (halted !== "paused") return;
      if (offlineNow()) {
        halted = "offline";
        set("offline");
      } else go();
    },
    async cancel() {
      if (completing || state === "success" || state === "canceled") {
        await run?.catch(() => undefined);
        return;
      }
      canceled = true;
      if (!run || state === "error") {
        if (cur) {
          await call({ action: "abort", ticket: cur.ticket }, true).catch(() => undefined);
          await drop(cur.key);
        }
        run = Promise.reject(aborted());
        run.catch(() => undefined);
        set("canceled");
        return;
      }
      inflight.forEach((x) => x.c.abort());
      wake();
      await run.catch(() => undefined);
    },
    subscribe(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}
