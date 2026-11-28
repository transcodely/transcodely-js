/**
 * The real browser core driving the real handler in-process, the XHR part
 * path, and the IndexedDB store against fake-indexeddb.
 */

import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createUpload, indexedDBStore, memoryStore, type UploadRecord } from "../../src/browser-upload/index.js";
import { createUploadHandler } from "../../src/browser-upload/server.js";
import { makeFile } from "./fakes.js";

const MiB = 1024 * 1024;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fake API client plus an object store its presigned URLs point at. */
function world() {
  const received = new Map<string, Uint8Array>();
  const putLog: string[] = [];
  const api: string[] = [];
  const exp = () => ({ seconds: BigInt(Math.floor(Date.now() / 1000) + 3600), nanos: 0 });
  const parts = (id: string, nums: number[]) => nums.map((p) => ({ partNumber: p, uploadUrl: `https://storage.test/${id}/${String(p)}` }));
  let failPart: number | undefined;
  const client = {
    videos: {
      createMultipartUpload: async (req: { totalParts?: number; title?: string; visibility?: string }) => {
        api.push(`create:${String(req.totalParts)}:${String(req.title)}:${String(req.visibility)}`);
        return { video: { id: "vid_e2e" }, uploadId: "up_e2e", parts: parts("vid_e2e", [1, 2]), urlsExpireAt: exp() };
      },
      getUploadPartUrls: async (req: { id: string; partNumbers: number[] }) => {
        api.push(`sign:${req.partNumbers.join(",")}`);
        return { parts: parts(req.id, req.partNumbers), urlsExpireAt: exp() };
      },
      completeMultipartUpload: async (req: { parts: { partNumber: number; etag: string }[] }) => {
        api.push(`complete:${req.parts.map((p) => `${String(p.partNumber)}=${p.etag}`).join(",")}`);
        return { video: { id: "vid_e2e", status: "processing" } };
      },
      abortMultipartUpload: async () => {
        api.push("abort");
        return {};
      },
    },
  };
  const handler = createUploadHandler({
    client,
    secret: "k".repeat(40),
    authorize: () => ({ allow: true, subject: "usr_1", defaults: { visibility: "private" } }),
  });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/upload") return handler(new Request(`https://app.test${url}`, init));
    const m = /^https:\/\/storage\.test\/vid_e2e\/(\d+)$/.exec(url)!;
    putLog.push(m[1]!);
    if (Number(m[1]) === failPart) return new Response(null, { status: 400 });
    received.set(m[1]!, new Uint8Array(await (init!.body as Blob).arrayBuffer()));
    return new Response(null, { headers: { etag: `"e${m[1]!}"` } });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    api,
    putLog,
    received,
    failOn: (n: number | undefined) => (failPart = n),
  };
}

describe("end to end: createUpload through createUploadHandler", () => {
  it("uploads a three-part file and completes with the handler's defaults", async () => {
    const w = world();
    const file = makeFile(33 * MiB);
    const result = await createUpload(file, {
      endpoint: "/api/upload",
      fetch: w.fetch,
      store: memoryStore(),
      metadata: { title: "Lecture" },
    }).start();

    expect(result).toEqual({ videoId: "vid_e2e", status: "processing", resumed: false });
    expect(w.api).toEqual(["create:3:Lecture:private", "sign:3", "complete:1=e1,2=e2,3=e3"]);
    const all = new Uint8Array(33 * MiB);
    let off = 0;
    for (const k of ["1", "2", "3"]) {
      all.set(w.received.get(k)!, off);
      off += w.received.get(k)!.length;
    }
    expect(w.received.get("1")!.length).toBe(16 * MiB);
    expect(w.received.get("3")!.length).toBe(1 * MiB);
    expect(Buffer.from(all).equals(Buffer.from(await file.arrayBuffer()))).toBe(true);
  });

  it("resumes through the handler with a real signed ticket, signing only missing parts", async () => {
    const w = world();
    const store = memoryStore();
    const file = makeFile(33 * MiB);
    w.failOn(2);
    await expect(
      createUpload(file, { endpoint: "/api/upload", fetch: w.fetch, store, concurrency: 1, retryDelayMs: 1 }).start(),
    ).rejects.toMatchObject({ code: "storage_error" });
    w.failOn(undefined);
    w.api.length = 0;
    w.putLog.length = 0;

    const result = await createUpload(file, { endpoint: "/api/upload", fetch: w.fetch, store, concurrency: 1 }).start();
    expect(result.resumed).toBe(true);
    expect(w.api).toEqual(["sign:2,3", "complete:1=e1,2=e2,3=e3"]);
    expect(w.putLog).toEqual(["2", "3"]);
  });
});

describe("XMLHttpRequest part path", () => {
  class FakeXHR {
    static instances: FakeXHR[] = [];
    static etag: string | null = '"xhr-etag"';
    upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    status = 0;
    method = "";
    url = "";
    body: Blob | undefined;
    constructor() {
      FakeXHR.instances.push(this);
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    send(body: Blob) {
      this.body = body;
      setTimeout(() => {
        this.upload.onprogress?.({ loaded: 1 });
        this.upload.onprogress?.({ loaded: 3 });
        this.status = 200;
        this.onload?.();
      }, 0);
    }
    getResponseHeader(name: string) {
      return name.toLowerCase() === "etag" ? FakeXHR.etag : null;
    }
    abort() {
      this.onabort?.();
    }
  }

  it("reports byte progress inside a part and reads the ETag header", async () => {
    FakeXHR.instances = [];
    FakeXHR.etag = '"xhr-etag"';
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const endpoint: string[] = [];
    const loaded: number[] = [];
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { action: string };
      endpoint.push(JSON.stringify(body));
      const res =
        body.action === "create"
          ? {
              ticket: "t", video_id: "vid_x", upload_id: "u", part_size: 4, total_parts: 1,
              expires_at: new Date(Date.now() + 86_400_000).toISOString(),
              parts: [{ part_number: 1, url: "https://storage.test/1" }],
              urls_expire_at: new Date(Date.now() + 3_600_000).toISOString(),
            }
          : { video_id: "vid_x", status: "processing" };
      return new Response(JSON.stringify(res));
    }) as typeof globalThis.fetch;

    await createUpload(makeFile(4), {
      endpoint: "/e",
      fetch,
      store: false,
      onProgress: (p) => loaded.push(p.loaded),
    }).start();

    expect(FakeXHR.instances).toHaveLength(1);
    expect(FakeXHR.instances[0]!.method).toBe("PUT");
    expect(FakeXHR.instances[0]!.url).toBe("https://storage.test/1");
    expect(FakeXHR.instances[0]!.body!.size).toBe(4);
    expect(loaded).toEqual([1, 3, 4]);
    expect(JSON.parse(endpoint.at(-1)!)).toEqual({ action: "complete", ticket: "t", parts: [{ part_number: 1, etag: "xhr-etag" }] });

    // A bucket whose CORS hides ETag fails with a message that says so.
    FakeXHR.etag = null;
    await expect(createUpload(makeFile(4), { endpoint: "/e", fetch, store: false }).start()).rejects.toMatchObject({
      code: "storage_error",
      message: expect.stringContaining("ExposeHeaders"),
    });
  });
});

describe("indexedDBStore", () => {
  const record = (key: string): UploadRecord => ({
    v: 1, key, ticket: "t", videoId: "vid_1", uploadId: "u", partSize: 4, totalParts: 2, size: 8,
    createdAt: 1, expiresAt: 2, parts: { 1: "e1" },
  });

  it("persists records across store instances (a reload)", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const a = indexedDBStore("db1");
    expect(await a.get("k")).toBeUndefined();
    await a.set("k", record("k"));
    const b = indexedDBStore("db1");
    expect(await b.get("k")).toEqual(record("k"));
    expect(await indexedDBStore("db2").get("k")).toBeUndefined();
    await b.delete("k");
    expect(await a.get("k")).toBeUndefined();
  });

  it("falls back to memory when IndexedDB is missing", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const s = indexedDBStore();
    await s.set("k", record("k"));
    expect(await s.get("k")).toEqual(record("k"));
    await s.delete("k");
    expect(await s.get("k")).toBeUndefined();
  });

  it("falls back to memory when IndexedDB refuses to open", async () => {
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    const s = indexedDBStore();
    await s.set("k", record("k"));
    expect(await s.get("k")).toEqual(record("k"));
  });

  it("drives a real resume", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const w = world();
    const file = makeFile(33 * MiB);
    w.failOn(3);
    await expect(createUpload(file, { endpoint: "/api/upload", fetch: w.fetch, concurrency: 1, retryDelayMs: 1 }).start()).rejects.toThrow();
    w.failOn(undefined);
    w.putLog.length = 0;
    const result = await createUpload(file, { endpoint: "/api/upload", fetch: w.fetch }).start();
    expect(result.resumed).toBe(true);
    expect(w.putLog).toEqual(["3"]);
  });
});

describe("import-time safety", () => {
  it("touches no browser globals when imported", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      Promise.all(
        ["index", "shared", "store", "upload", "protocol"].map((f) => fs.readFile(`src/browser-upload/${f}.ts`, "utf8")),
      ),
    );
    for (const code of src) {
      expect(code).not.toMatch(/from "(node:|@bufbuild|react|\.\.\/)/);
    }
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("indexedDB", undefined);
    vi.resetModules();
    const mod = await import("../../src/browser-upload/index.js");
    expect(typeof mod.createUpload).toBe("function");
  });
});
