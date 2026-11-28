/**
 * Acceptance criterion 1 of the browser uploader brief: the core against a
 * fake upload endpoint and a fake object store.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_FILE_SIZE,
  TranscodelyUploadError,
  acceptsFile,
  createUpload,
  memoryStore,
  partSizeFor,
  type CreateUploadOptions,
  type UploadState,
  type UploadStore,
} from "../../src/browser-upload/index.js";
import { ENDPOINT, fakeBackend, makeFile, until } from "./fakes.js";

const MiB = 1024 * 1024;

function setup(backend: ReturnType<typeof fakeBackend>, extra: Partial<CreateUploadOptions> = {}) {
  const states: UploadState[] = [];
  const percents: number[] = [];
  const options: CreateUploadOptions = {
    endpoint: ENDPOINT,
    fetch: backend.fetch,
    store: memoryStore(),
    retryDelayMs: 1,
    onStateChange: (s) => states.push(s),
    onProgress: (p) => percents.push(p.percent),
    ...extra,
  };
  return { options, states, percents };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createUpload", () => {
  it("happy path: uploads every part with bounded concurrency and completes", async () => {
    const backend = fakeBackend();
    const file = makeFile(18); // 5 parts of 4 bytes, the last 2
    const { store, live } = trackedStore();
    const { options, states, percents } = setup(backend, { store, metadata: { title: "Talk" } });
    const upload = createUpload(file, options);

    const result = await upload.start();

    expect(result).toEqual({ videoId: "vid_1", status: "processing", resumed: false });
    expect(states).toEqual(["preparing", "uploading", "completing", "success"]);
    expect(upload.state).toBe("success");
    expect(upload.videoId).toBe("vid_1");
    expect(upload.progress).toEqual({ loaded: 18, total: 18, percent: 100 });
    expect(percents.at(-1)).toBe(100);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents); // never backwards

    expect(backend.calls[0]).toEqual({
      action: "create",
      file: { name: "talk.mp4", size: 18, type: "video/mp4", last_modified: 1_700_000_000_000 },
      metadata: { title: "Talk" },
    });
    // create seeded parts 1-2; the rest were signed once, in one batch.
    expect(backend.calls.filter((c) => c.action === "sign_parts")).toEqual([
      { action: "sign_parts", ticket: "ticket-vid_1", part_numbers: [3, 4, 5] },
    ]);
    expect(backend.putParts().sort()).toEqual([1, 2, 3, 4, 5]);
    expect(backend.maxInFlight).toBeLessThanOrEqual(3);
    const bytes = backend.puts
      .sort((a, b) => a.part - b.part)
      .flatMap((p) => [...p.body]);
    expect(bytes).toEqual([...new Uint8Array(await file.arrayBuffer())]);
    expect(backend.calls.at(-1)).toEqual({
      action: "complete",
      ticket: "ticket-vid_1",
      parts: [1, 2, 3, 4, 5].map((n) => ({ part_number: n, etag: `etag-${String(n)}` })),
    });
    // A finished upload leaves nothing to resume.
    expect(live.size).toBe(0);
  });

  it("a part fails twice then succeeds", async () => {
    const backend = fakeBackend({ failures: { 2: [500, 503] } });
    const { options } = setup(backend, { concurrency: 1 });
    const result = await createUpload(makeFile(12), options).start();

    expect(result.status).toBe("processing");
    expect(backend.putParts()).toEqual([1, 2, 2, 2, 3]);
    const complete = backend.calls.at(-1);
    expect(complete).toMatchObject({ action: "complete", parts: [{ part_number: 1 }, { part_number: 2, etag: "etag-2" }, { part_number: 3 }] });
  });

  it("a part that keeps failing stops the upload after the retry budget", async () => {
    const backend = fakeBackend({ failures: { 1: [500, 500, 500] } });
    const { options } = setup(backend, { concurrency: 1, retries: 2 });
    const upload = createUpload(makeFile(8), options);
    await expect(upload.start()).rejects.toMatchObject({ code: "storage_error", status: 500, retryable: true });
    expect(upload.state).toBe("error");
    expect(backend.putParts()).toEqual([1, 1, 1]);
    expect(backend.actions()).not.toContain("complete");
  });

  it("a 403 from storage re-signs that part before retrying", async () => {
    const backend = fakeBackend({ failures: { 1: [403] } });
    const { options } = setup(backend, { concurrency: 1 });
    await createUpload(makeFile(8), options).start();
    expect(backend.calls.filter((c) => c.action === "sign_parts")).toEqual([
      { action: "sign_parts", ticket: "ticket-vid_1", part_numbers: [1] },
    ]);
    expect(backend.putParts()).toEqual([1, 1, 2]);
  });

  it("offline then online: in-flight parts are aborted and the upload continues", async () => {
    const win = new EventTarget();
    const nav = { onLine: true };
    vi.stubGlobal("window", win);
    vi.stubGlobal("navigator", nav);
    const backend = fakeBackend();
    const { options, states } = setup(backend);
    backend.hold();
    const upload = createUpload(makeFile(16), options);
    const done = upload.start();
    await until(() => backend.heldCount === 3, "three parts in flight");

    nav.onLine = false;
    win.dispatchEvent(new Event("offline"));
    expect(upload.state).toBe("offline");
    await until(() => backend.abortedPuts === 3, "in-flight PUTs aborted");
    backend.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(backend.puts).toHaveLength(3); // nothing new sent while offline

    nav.onLine = true;
    win.dispatchEvent(new Event("online"));
    await expect(done).resolves.toMatchObject({ videoId: "vid_1" });
    expect(states).toEqual(["preparing", "uploading", "offline", "uploading", "completing", "success"]);
    expect(backend.putParts().slice(3).sort()).toEqual([1, 2, 3, 4]);
  });

  it("a failed PUT while navigator reports offline waits instead of burning retries", async () => {
    const win = new EventTarget();
    const nav = { onLine: false };
    vi.stubGlobal("window", win);
    vi.stubGlobal("navigator", nav);
    // Two failures against a budget of one retry: this only succeeds if the
    // attempt made while offline is not counted.
    const backend = fakeBackend({ failures: { 1: [500, 500] } });
    const upload = createUpload(makeFile(4), setup(backend, { concurrency: 1, retries: 1 }).options);
    const done = upload.start();
    await until(() => upload.state === "offline", "offline state");
    expect(backend.putParts()).toEqual([1]);
    nav.onLine = true;
    win.dispatchEvent(new Event("online"));
    await expect(done).resolves.toMatchObject({ status: "processing" });
    expect(backend.putParts()).toEqual([1, 1, 1]);
  });

  it("pause and resume: pausing aborts in-flight parts and resume finishes the rest", async () => {
    const backend = fakeBackend();
    const { options, states } = setup(backend, { concurrency: 2 });
    const upload = createUpload(makeFile(16), options);
    // Let part 1 and 2 land, then hold 3 and 4 in flight.
    const done = upload.start();
    backend.hold();
    await until(() => backend.heldCount === 2, "parts 1 and 2 in flight");
    backend.release();
    backend.hold();
    await until(() => backend.heldCount === 2, "parts 3 and 4 in flight");
    upload.pause();
    expect(upload.state).toBe("paused");
    await until(() => backend.abortedPuts === 2, "in-flight PUTs aborted");
    expect(upload.progress.loaded).toBe(8); // only the finished parts count
    backend.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(backend.puts).toHaveLength(4);

    upload.resume();
    await expect(done).resolves.toMatchObject({ videoId: "vid_1", resumed: false });
    expect(backend.putParts()).toEqual([1, 2, 3, 4, 3, 4]);
    expect(states).toEqual(["preparing", "uploading", "paused", "uploading", "completing", "success"]);
  });

  it("cancel aborts the multipart upload", async () => {
    const backend = fakeBackend();
    const { store, live } = trackedStore();
    const { options, states } = setup(backend, { store });
    backend.hold();
    const upload = createUpload(makeFile(16), options);
    const done = upload.start();
    await until(() => backend.heldCount === 3, "parts in flight");

    await upload.cancel();

    await expect(done).rejects.toMatchObject({ code: "aborted" });
    expect(upload.state).toBe("canceled");
    expect(states.at(-1)).toBe("canceled");
    expect(backend.calls.at(-1)).toEqual({ action: "abort", ticket: "ticket-vid_1" });
    expect(backend.actions()).not.toContain("complete");
    expect(backend.abortedPuts).toBe(3);
    expect(live.size).toBe(0);
    // A canceled upload stays canceled.
    await expect(upload.start()).rejects.toMatchObject({ code: "aborted" });
  });

  it("cancel after an error aborts the upload it left behind", async () => {
    const backend = fakeBackend({ failures: { 2: [400] } });
    const { options } = setup(backend, { concurrency: 1 });
    const upload = createUpload(makeFile(8), options);
    await expect(upload.start()).rejects.toMatchObject({ code: "storage_error", status: 400 });
    await upload.cancel();
    expect(upload.state).toBe("canceled");
    expect(backend.calls.at(-1)).toEqual({ action: "abort", ticket: "ticket-vid_1" });
  });

  it("resume after a simulated reload uploads only missing parts", async () => {
    const store = memoryStore();
    const file = makeFile(18);
    // First page: parts 1 and 2 land, part 3 is refused for good.
    const first = fakeBackend({ failures: { 3: [400] } });
    await expect(createUpload(file, setup(first, { store, concurrency: 1 }).options).start()).rejects.toMatchObject({
      code: "storage_error",
    });
    expect(first.putParts()).toEqual([1, 2, 3]);

    // Reload: a new page, a new upload object, the same file picked again.
    const second = fakeBackend();
    const result = await createUpload(
      makeFile(18),
      setup(second, { store, concurrency: 1 }).options,
    ).start();

    expect(result).toEqual({ videoId: "vid_1", status: "processing", resumed: true });
    expect(second.actions()).toEqual(["sign_parts", "complete"]);
    expect(second.calls[0]).toEqual({ action: "sign_parts", ticket: "ticket-vid_1", part_numbers: [3, 4, 5] });
    expect(second.putParts()).toEqual([3, 4, 5]);
    expect(second.calls[1]).toEqual({
      action: "complete",
      ticket: "ticket-vid_1",
      parts: [1, 2, 3, 4, 5].map((n) => ({ part_number: n, etag: `etag-${String(n)}` })),
    });
  });

  it("resume after a reload skips parts that finished out of order", async () => {
    const { store, live } = trackedStore();
    const file = makeFile(18);
    const first = fakeBackend({ failures: { 3: [400] } });
    await expect(createUpload(file, setup(first, { store, concurrency: 1 }).options).start()).rejects.toThrow();
    // With several lanes, part 2 can land while part 1 does not.
    const [key] = [...live];
    const rec = (await store.get(key!))!;
    delete rec.parts[1];
    await store.set(key!, rec);

    const second = fakeBackend();
    const result = await createUpload(file, setup(second, { store, concurrency: 1 }).options).start();
    expect(result.resumed).toBe(true);
    expect(second.calls[0]).toEqual({ action: "sign_parts", ticket: "ticket-vid_1", part_numbers: [1, 3, 4, 5] });
    expect(second.putParts()).toEqual([1, 3, 4, 5]);
  });

  it("a resumed upload signs missing parts in batches of at most 100", async () => {
    const store = memoryStore();
    const file = makeFile(250); // 250 parts of 1 byte
    const first = fakeBackend({ partSize: 1, failures: { 2: [400] } });
    await expect(createUpload(file, setup(first, { store, concurrency: 1 }).options).start()).rejects.toThrow();
    const second = fakeBackend({ partSize: 1 });
    await createUpload(file, setup(second, { store, concurrency: 1 }).options).start();
    const signed = second.calls.flatMap((c) => (c.action === "sign_parts" ? [c.part_numbers] : []));
    expect(signed.map((s) => s.length)).toEqual([100, 100, 49]);
    expect(signed.flat()).toEqual(Array.from({ length: 249 }, (_, i) => i + 2));
    expect(second.putParts()).not.toContain(1);
  });

  it("a stale record restarts cleanly", async () => {
    const store = memoryStore();
    const file = makeFile(12);
    // A record whose ticket expires in 5 minutes: inside the 10-minute margin.
    const first = fakeBackend({ failures: { 2: [400] }, ttlMs: 5 * 60_000 });
    await expect(createUpload(file, setup(first, { store, concurrency: 1 }).options).start()).rejects.toThrow();

    const second = fakeBackend();
    const result = await createUpload(file, setup(second, { store }).options).start();
    expect(result.resumed).toBe(false);
    expect(second.actions()[0]).toBe("create");
    expect(second.putParts().sort()).toEqual([1, 2, 3]);
  });

  it("a stale record the handler no longer honours restarts once from zero", async () => {
    const store = memoryStore();
    const file = makeFile(12);
    const first = fakeBackend({ failures: { 2: [400] } });
    await expect(createUpload(file, setup(first, { store, concurrency: 1 }).options).start()).rejects.toThrow();

    // The handler says the old ticket is past its expiry.
    const second = fakeBackend({
      endpointError: { status: 410, code: "upload_expired", message: "This upload has expired.", actions: ["sign_parts"] },
    });
    const upload = createUpload(file, setup(second, { store, concurrency: 1 }).options);
    const err = await upload.start().catch((e: unknown) => e);
    // The fresh upload's own sign_parts also gets 410 here, and that one is fatal.
    expect(err).toMatchObject({ code: "upload_expired", status: 410 });
    expect(second.actions()).toEqual(["sign_parts", "create", "sign_parts"]);

    // With a handler that only refused the old ticket, the restart completes.
    const third = fakeBackend({ failures: { 2: [400] } });
    await expect(createUpload(file, setup(third, { store, concurrency: 1 }).options).start()).rejects.toThrow();
    let refused = false;
    const fourth = fakeBackend();
    const result = await createUpload(file, {
      ...setup(fourth, { store, concurrency: 1 }).options,
      fetch: async (input, init) => {
        const body = String(input) === ENDPOINT ? (JSON.parse(String(init?.body)) as { action: string }) : undefined;
        if (!refused && body?.action === "sign_parts") {
          refused = true;
          return new Response(JSON.stringify({ error: { code: "ticket_invalid", message: "x" } }), { status: 403 });
        }
        return fourth.fetch(input, init);
      },
    }).start();
    expect(result).toMatchObject({ resumed: false, videoId: "vid_1" });
    expect(fourth.actions()[0]).toBe("create");
    expect(fourth.putParts().sort()).toEqual([1, 2, 3]);
  });

  it.each([
    ["size", makeFile(13)],
    ["lastModified", makeFile(12, "talk.mp4", 1_700_000_000_001)],
  ])("a changed file (%s) is not resumed", async (_what, changed) => {
    const store = memoryStore();
    const first = fakeBackend({ failures: { 2: [400] } });
    await expect(createUpload(makeFile(12), setup(first, { store, concurrency: 1 }).options).start()).rejects.toThrow();

    const second = fakeBackend();
    const result = await createUpload(changed, setup(second, { store }).options).start();
    expect(result.resumed).toBe(false);
    expect(second.actions()[0]).toBe("create");
    expect(second.putParts()).toContain(1);
  });

  it("a file with the same name, size and date but different bytes is not resumed", async () => {
    const store = memoryStore();
    const first = fakeBackend({ failures: { 2: [400] } });
    await expect(createUpload(makeFile(12), setup(first, { store, concurrency: 1 }).options).start()).rejects.toThrow();
    const other = new File([new Uint8Array(12).fill(7)], "talk.mp4", { type: "video/mp4", lastModified: 1_700_000_000_000 });
    const second = fakeBackend();
    const result = await createUpload(other, setup(second, { store }).options).start();
    expect(result.resumed).toBe(false);
    expect(second.actions()[0]).toBe("create");
  });

  it("store: false keeps nothing to resume", async () => {
    const backend = fakeBackend({ failures: { 2: [400] } });
    await expect(
      createUpload(makeFile(8), { ...setup(backend, { concurrency: 1 }).options, store: false }).start(),
    ).rejects.toThrow();
    const again = fakeBackend();
    await createUpload(makeFile(8), { ...setup(again).options, store: false }).start();
    expect(again.actions()[0]).toBe("create");
  });

  it("each finished part is persisted before it counts as done", async () => {
    const writes: number[][] = [];
    const inner = memoryStore();
    const store: UploadStore = {
      get: (k) => inner.get(k),
      delete: (k) => inner.delete(k),
      set: async (k, r) => {
        writes.push(Object.keys(r.parts).map(Number));
        await inner.set(k, r);
      },
    };
    const backend = fakeBackend();
    await createUpload(makeFile(12), setup(backend, { store, concurrency: 1 }).options).start();
    expect(writes).toEqual([[], [1], [1, 2], [1, 2, 3]]);
  });

  it("start() is idempotent while running", async () => {
    const backend = fakeBackend();
    const upload = createUpload(makeFile(8), setup(backend).options);
    const a = upload.start();
    expect(upload.start()).toBe(a);
    await a;
    expect(backend.actions().filter((x) => x === "create")).toHaveLength(1);
  });

  it("start() after an error resumes where it stopped", async () => {
    const backend = fakeBackend({ failures: { 2: [400] } });
    const upload = createUpload(makeFile(12), setup(backend, { concurrency: 1 }).options);
    await expect(upload.start()).rejects.toThrow();
    const result = await upload.start();
    expect(result.resumed).toBe(true);
    expect(backend.putParts()).toEqual([1, 2, 2, 3]);
  });

  it("a missing ETag names the CORS setting to fix", async () => {
    const backend = fakeBackend({ omitEtag: true });
    const upload = createUpload(makeFile(4), setup(backend).options);
    const err = (await upload.start().catch((e: unknown) => e)) as TranscodelyUploadError;
    expect(err).toBeInstanceOf(TranscodelyUploadError);
    expect(err.code).toBe("storage_error");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("ExposeHeaders");
    expect(backend.putParts()).toEqual([1]);
  });

  it.each([
    [makeFile(0), {}, "file_empty"],
    [makeFile(10), { maxFileSize: 9 }, "file_too_large"],
    [makeFile(10, "notes.txt", 1, "text/plain"), { accept: "video/*,.mkv" }, "file_type_not_accepted"],
  ] as const)("refuses a bad file before calling the endpoint (%#)", async (file, extra, code) => {
    const backend = fakeBackend();
    const upload = createUpload(file, setup(backend, extra).options);
    await expect(upload.start()).rejects.toMatchObject({ code });
    expect(upload.error?.code).toBe(code);
    expect(backend.calls).toEqual([]);
  });

  it("states the size limit in plain words", async () => {
    const upload = createUpload(makeFile(10), setup(fakeBackend(), { maxFileSize: 9 }).options);
    await expect(upload.start()).rejects.toThrow("This file is 10 bytes. The largest file you can upload is 9 bytes.");
  });

  it("endpoint errors carry the handler's code and message; 4xx are not retried", async () => {
    const backend = fakeBackend();
    let calls = 0;
    const upload = createUpload(makeFile(4), {
      ...setup(backend).options,
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ error: { code: "forbidden", message: "Uploads are closed today." } }), { status: 403 });
      },
    });
    await expect(upload.start()).rejects.toMatchObject({
      code: "forbidden",
      message: "Uploads are closed today.",
      status: 403,
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  it("endpoint network errors and 5xx are retried", async () => {
    const backend = fakeBackend();
    let n = 0;
    const result = await createUpload(makeFile(4), {
      ...setup(backend).options,
      fetch: async (input, init) => {
        if (String(input) === ENDPOINT && n++ < 2) {
          if (n === 1) throw new TypeError("Failed to fetch");
          return new Response("<html>bad gateway</html>", { status: 502 });
        }
        return backend.fetch(input, init);
      },
    }).start();
    expect(result.status).toBe("processing");
  });

  it("sends custom headers and credentials to the endpoint only", async () => {
    const backend = fakeBackend();
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    await createUpload(makeFile(4), {
      ...setup(backend).options,
      headers: async () => ({ authorization: "Bearer t" }),
      credentials: "include",
      fetch: (input, init) => {
        seen.push({ url: String(input), init });
        return backend.fetch(input, init);
      },
    }).start();
    const endpointCall = seen.find((s) => s.url === ENDPOINT)!;
    expect(endpointCall.init?.headers).toMatchObject({ authorization: "Bearer t", "content-type": "application/json" });
    expect(endpointCall.init?.credentials).toBe("include");
    expect(seen.find((s) => s.url.startsWith("https://storage.test"))!.init?.headers).toBeUndefined();
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    const backend = fakeBackend();
    const upload = createUpload(makeFile(8), setup(backend).options);
    let hits = 0;
    const off = upload.subscribe(() => hits++);
    await upload.start();
    expect(hits).toBeGreaterThan(3);
    const before = hits;
    off();
    await upload.cancel();
    expect(hits).toBe(before);
  });

  it("removes its window listeners once the upload settles", async () => {
    const win = new EventTarget();
    const add = vi.spyOn(win, "addEventListener");
    const remove = vi.spyOn(win, "removeEventListener");
    vi.stubGlobal("window", win);
    await createUpload(makeFile(4), setup(fakeBackend()).options).start();
    expect(add.mock.calls.map((c) => c[0]).sort()).toEqual(["offline", "online"]);
    expect(remove.mock.calls.map((c) => c[1])).toEqual(add.mock.calls.map((c) => c[1]));
  });
});

describe("partSizeFor / acceptsFile", () => {
  it("never goes below 16 MiB and keeps the part count within 10,000", () => {
    expect(partSizeFor(1)).toBe(16 * MiB);
    expect(partSizeFor(MAX_FILE_SIZE)).toBe(16 * MiB);
    const huge = 200 * 1024 * MiB;
    expect(partSizeFor(huge) % MiB).toBe(0);
    expect(Math.ceil(huge / partSizeFor(huge))).toBeLessThanOrEqual(10_000);
  });

  it("follows <input accept> rules", () => {
    const mp4 = { name: "A.MP4", type: "video/mp4" };
    expect(acceptsFile(mp4)).toBe(true);
    expect(acceptsFile(mp4, "video/*")).toBe(true);
    expect(acceptsFile(mp4, "audio/*, .mp4")).toBe(true);
    expect(acceptsFile(mp4, "video/webm")).toBe(false);
    expect(acceptsFile({ name: "a.mkv", type: "" }, "video/*")).toBe(false);
    expect(acceptsFile({ name: "a.mkv", type: "" }, "video/*,.mkv")).toBe(true);
  });
});

/** A memory store that reports which keys still hold a record. */
function trackedStore() {
  const inner = memoryStore();
  const live = new Set<string>();
  const store: UploadStore = {
    get: (k) => inner.get(k),
    set: async (k, r) => {
      live.add(k);
      await inner.set(k, r);
    },
    delete: async (k) => {
      live.delete(k);
      await inner.delete(k);
    },
  };
  return { store, live };
}
