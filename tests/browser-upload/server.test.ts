/**
 * Acceptance criterion 2 of the browser uploader brief: `createUploadHandler`
 * refuses before it creates, keeps the app's defaults out of the browser's
 * reach, and binds every later call to the upload its ticket names.
 */

import { describe, expect, it, vi } from "vitest";

import { InvalidRequestError, NotFoundError } from "../../src/errors.js";
import { createUploadHandler, type AuthorizeResult, type UploadHandlerOptions } from "../../src/browser-upload/server.js";

const SECRET = "s".repeat(32);
const MiB = 1024 * 1024;

function fakeClient() {
  let n = 0;
  const parts = (id: string, nums: number[]) => nums.map((p) => ({ partNumber: p, uploadUrl: `https://storage.test/${id}/${String(p)}` }));
  const exp = { seconds: BigInt(Math.floor(Date.now() / 1000) + 3600), nanos: 0 };
  const videos = {
    createMultipartUpload: vi.fn(async (req: { totalParts?: number }) => {
      const id = `vid_${String(++n)}`;
      return {
        video: { id },
        uploadId: `up_${id}`,
        parts: parts(id, Array.from({ length: Math.min(req.totalParts ?? 1, 50) }, (_, i) => i + 1)),
        urlsExpireAt: exp,
      };
    }),
    getUploadPartUrls: vi.fn(async (req: { id: string; partNumbers: number[] }) => ({
      parts: parts(req.id, req.partNumbers),
      urlsExpireAt: exp,
    })),
    completeMultipartUpload: vi.fn(async (req: { id: string }) => ({ video: { id: req.id, status: "processing" } })),
    abortMultipartUpload: vi.fn(async () => ({})),
    get: vi.fn(async (id: string) => ({ id, status: "uploading" })),
  };
  return { videos };
}

type Client = ReturnType<typeof fakeClient>;

function handler(client: Client, opts: Partial<UploadHandlerOptions> = {}) {
  return createUploadHandler({
    client,
    secret: SECRET,
    authorize: () => ({ allow: true }),
    ...opts,
  });
}

const post = (body: unknown) =>
  new Request("https://app.test/api/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const FILE = { name: "talk.mp4", size: 40 * MiB, type: "video/mp4", last_modified: 1 };

async function call(h: (r: Request) => Promise<Response>, body: unknown) {
  const res = await h(post(body));
  return { status: res.status, body: (await res.json()) as any };
}

async function create(h: (r: Request) => Promise<Response>) {
  const r = await call(h, { action: "create", file: FILE });
  expect(r.status).toBe(200);
  return r.body as { ticket: string; video_id: string; total_parts: number };
}

describe("createUploadHandler", () => {
  it("create opens a multipart upload and returns a ticket and the first URLs", async () => {
    const client = fakeClient();
    const { status, body } = await call(handler(client), { action: "create", file: FILE, metadata: { title: "Talk" } });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      video_id: "vid_1",
      upload_id: "up_vid_1",
      part_size: 16 * MiB,
      total_parts: 3,
      parts: [1, 2, 3].map((n) => ({ part_number: n, url: `https://storage.test/vid_1/${String(n)}` })),
    });
    expect(typeof body.ticket).toBe("string");
    expect(Date.parse(body.expires_at) - Date.now()).toBeGreaterThan(86_000_000);
    expect(Date.parse(body.urls_expire_at)).toBeGreaterThan(Date.now());
    expect(client.videos.createMultipartUpload).toHaveBeenCalledWith({
      title: "Talk",
      filename: "talk.mp4",
      contentType: "video/mp4",
      sizeBytes: BigInt(40 * MiB),
      totalParts: 3,
      partSizeBytes: BigInt(16 * MiB),
    });
  });

  it.each(["create", "sign_parts", "complete", "abort"])(
    "authorize refusal returns 403 and creates nothing (%s)",
    async (action) => {
      const client = fakeClient();
      const allowed = handler(client);
      const opened = await create(allowed);
      client.videos.createMultipartUpload.mockClear();

      const refusing = handler(client, { authorize: () => ({ allow: false }) });
      const { status, body } = await call(refusing, {
        action,
        file: FILE,
        ticket: opened.ticket,
        part_numbers: [1],
        parts: [1, 2, 3].map((n) => ({ part_number: n, etag: "e" })),
      });
      expect(status).toBe(403);
      expect(body).toEqual({ error: { code: "forbidden", message: "This upload was refused." } });
      for (const fn of Object.values(client.videos)) expect(fn).not.toHaveBeenCalled();
    },
  );

  it("authorize sees the action and the file, and can refuse with 401 and its own message", async () => {
    const client = fakeClient();
    const authorize = vi.fn((): AuthorizeResult => ({ allow: false, status: 401, message: "Log in first." }));
    const { status, body } = await call(handler(client, { authorize }), { action: "create", file: FILE });
    expect(status).toBe(401);
    expect(body.error).toEqual({ code: "unauthenticated", message: "Log in first." });
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), { action: "create", file: FILE });
    expect(client.videos.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("defaults from authorize cannot be overridden by the browser", async () => {
    const client = fakeClient();
    const h = handler(client, {
      authorize: () => ({
        allow: true,
        defaults: { visibility: "private", tags: ["user:42"], preset: "pst_app", appId: "app_mine", title: "Forced title" },
      }),
    });
    const { status } = await call(h, {
      action: "create",
      file: FILE,
      metadata: { title: "Browser title", description: "Browser description", visibility: "public" },
      visibility: "public",
      tags: ["admin"],
      preset: "pst_evil",
      app_id: "app_other",
      appId: "app_other",
      sourcePinned: true,
      source_pinned: true,
    });
    expect(status).toBe(200);
    expect(client.videos.createMultipartUpload).toHaveBeenCalledTimes(1);
    expect(client.videos.createMultipartUpload.mock.calls[0]![0]).toEqual({
      title: "Forced title",
      description: "Browser description",
      visibility: "private",
      tags: ["user:42"],
      preset: "pst_app",
      appId: "app_mine",
      filename: "talk.mp4",
      contentType: "video/mp4",
      sizeBytes: BigInt(40 * MiB),
      totalParts: 3,
      partSizeBytes: BigInt(16 * MiB),
    });
  });

  it("defaults cannot override the file's own facts either", async () => {
    const client = fakeClient();
    const h = handler(client, {
      authorize: () => ({ allow: true, defaults: { sizeBytes: 1n, totalParts: 1 } as never }),
    });
    await call(h, { action: "create", file: FILE });
    expect(client.videos.createMultipartUpload.mock.calls[0]![0]).toMatchObject({ sizeBytes: BigInt(40 * MiB), totalParts: 3 });
  });

  it("sign, complete and abort act only on the ticket's upload", async () => {
    const client = fakeClient();
    const h = handler(client);
    const { ticket } = await create(h);
    await create(h); // vid_2 exists too

    const signed = await call(h, { action: "sign_parts", ticket, part_numbers: [3, 1], id: "vid_2", upload_id: "up_vid_2" });
    expect(signed.status).toBe(200);
    expect(signed.body.parts).toEqual([
      { part_number: 3, url: "https://storage.test/vid_1/3" },
      { part_number: 1, url: "https://storage.test/vid_1/1" },
    ]);
    expect(client.videos.getUploadPartUrls).toHaveBeenCalledWith({ id: "vid_1", uploadId: "up_vid_1", partNumbers: [3, 1] });

    const done = await call(h, {
      action: "complete",
      ticket,
      video_id: "vid_2",
      parts: [3, 1, 2].map((n) => ({ part_number: n, etag: `e${String(n)}` })),
    });
    expect(done).toEqual({ status: 200, body: { video_id: "vid_1", status: "processing" } });
    expect(client.videos.completeMultipartUpload).toHaveBeenCalledWith({
      id: "vid_1",
      uploadId: "up_vid_1",
      parts: [1, 2, 3].map((n) => ({ partNumber: n, etag: `e${String(n)}` })),
    });

    expect(await call(h, { action: "abort", ticket })).toEqual({ status: 200, body: {} });
    expect(client.videos.abortMultipartUpload).toHaveBeenCalledWith({ id: "vid_1", uploadId: "up_vid_1" });
  });

  describe("a browser cannot sign or complete an upload it did not create", () => {
    const tamper = (ticket: string, edit: (p: Record<string, unknown>) => void) => {
      const [body, sig] = ticket.split(".");
      const payload = JSON.parse(Buffer.from(body!, "base64url").toString()) as Record<string, unknown>;
      edit(payload);
      return `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig!}`;
    };

    async function expectRefused(ticket: unknown, status: number, code: string, h?: (r: Request) => Promise<Response>, client?: Client) {
      const c = client ?? fakeClient();
      const target = h ?? handler(c);
      for (const body of [
        { action: "sign_parts", ticket, part_numbers: [1] },
        { action: "complete", ticket, parts: [1, 2, 3].map((n) => ({ part_number: n, etag: "e" })) },
        { action: "abort", ticket },
      ]) {
        const r = await call(target, body);
        expect(r.status).toBe(status);
        expect(r.body.error.code).toBe(code);
      }
      expect(c.videos.getUploadPartUrls).not.toHaveBeenCalled();
      expect(c.videos.completeMultipartUpload).not.toHaveBeenCalled();
      expect(c.videos.abortMultipartUpload).not.toHaveBeenCalled();
    }

    it("a tampered ticket (another upload's ids, same signature) is refused", async () => {
      const client = fakeClient();
      const h = handler(client);
      const { ticket } = await create(h);
      await expectRefused(tamper(ticket, (p) => ((p.vid = "vid_victim"), (p.uid = "up_victim"))), 403, "ticket_invalid", h, client);
      await expectRefused(tamper(ticket, (p) => (p.exp = (p.exp as number) + 1)), 403, "ticket_invalid", h, client);
    });

    it("a ticket signed with another secret is refused", async () => {
      const other = handler(fakeClient(), { secret: "o".repeat(32) });
      const { ticket } = await create(other);
      const client = fakeClient();
      await expectRefused(ticket, 403, "ticket_invalid", handler(client), client);
    });

    it.each([undefined, 42, "", "abc", "a.b.c", "!!!.???"])("garbage ticket %j is refused", async (ticket) => {
      await expectRefused(ticket, 403, "ticket_invalid");
    });

    it("an expired ticket answers 410 upload_expired", async () => {
      const client = fakeClient();
      const h = handler(client, { ticketTtlSeconds: 60 });
      const { ticket } = await create(h);
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 61_000);
        await expectRefused(ticket, 410, "upload_expired", h, client);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a ticket issued to one subject is refused for another", async () => {
      const client = fakeClient();
      let user: string | undefined = "usr_alice";
      const h = handler(client, { authorize: () => ({ allow: true, ...(user ? { subject: user } : {}) }) });
      const { ticket } = await create(h);
      user = "usr_mallory";
      await expectRefused(ticket, 403, "ticket_invalid", h, client);
      user = undefined;
      await expectRefused(ticket, 403, "ticket_invalid", h, client);
      user = "usr_alice";
      expect((await call(h, { action: "sign_parts", ticket, part_numbers: [1] })).status).toBe(200);
    });

    it.each([
      [[0]],
      [[4]],
      [[1.5]],
      [["1"]],
      [[1, 1]],
      [[]],
      [Array.from({ length: 101 }, (_, i) => i + 1)],
      ["1"],
    ])("part numbers %j outside the ticket's upload are refused", async (part_numbers) => {
      const client = fakeClient();
      const h = handler(client);
      const { ticket } = await create(h); // 3 parts
      const r = await call(h, { action: "sign_parts", ticket, part_numbers });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_request");
      expect(client.videos.getUploadPartUrls).not.toHaveBeenCalled();
    });

    it.each([
      [[1, 2].map((n) => ({ part_number: n, etag: "e" }))],
      [[1, 2, 2].map((n) => ({ part_number: n, etag: "e" }))],
      [[1, 2, 4].map((n) => ({ part_number: n, etag: "e" }))],
      [[1, 2, 3].map((n) => ({ part_number: n, etag: n === 2 ? "" : "e" }))],
      [[1, 2, 3, 4].map((n) => ({ part_number: n, etag: "e" }))],
    ])("complete with parts %j is refused", async (parts) => {
      const client = fakeClient();
      const h = handler(client);
      const { ticket } = await create(h);
      const r = await call(h, { action: "complete", ticket, parts });
      expect(r.status).toBe(400);
      expect(client.videos.completeMultipartUpload).not.toHaveBeenCalled();
    });
  });

  it("missing authorize or a short secret throws at construction", () => {
    const client = fakeClient();
    expect(() => createUploadHandler({ client, secret: SECRET } as unknown as UploadHandlerOptions)).toThrow(/authorize/);
    expect(() => createUploadHandler({ client, secret: "short", authorize: () => ({ allow: true }) })).toThrow(
      /at least 32 characters.*TRANSCODELY_UPLOAD_SECRET/,
    );
    vi.stubEnv("TRANSCODELY_UPLOAD_SECRET", "");
    try {
      expect(() => createUploadHandler({ client, authorize: () => ({ allow: true }) })).toThrow(/TRANSCODELY_UPLOAD_SECRET/);
      vi.stubEnv("TRANSCODELY_UPLOAD_SECRET", "e".repeat(32));
      expect(() => createUploadHandler({ client, authorize: () => ({ allow: true }) })).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("enforces size and type limits before creating", async () => {
    const client = fakeClient();
    const h = handler(client, { maxFileSize: 10 * MiB });
    const big = await call(h, { action: "create", file: FILE });
    expect(big.status).toBe(413);
    expect(big.body.error).toEqual({
      code: "file_too_large",
      message: "This file is 40 MB. The largest file you can upload is 10 MB.",
    });
    const txt = await call(h, { action: "create", file: { ...FILE, name: "a.txt", type: "text/plain", size: 10 } });
    expect(txt.status).toBe(415);
    expect(txt.body.error.code).toBe("file_type_not_accepted");
    const huge = await call(handler(client, { maxFileSize: 1e12 }), { action: "create", file: { ...FILE, size: 5_368_709_121 } });
    expect(huge.status).toBe(413);
    expect(client.videos.createMultipartUpload).not.toHaveBeenCalled();
  });

  it.each([
    ["not json", "{"],
    ["an array", []],
    ["an unknown action", { action: "delete" }],
    ["no file", { action: "create" }],
    ["an empty file", { action: "create", file: { ...FILE, size: 0 } }],
    ["a long title", { action: "create", file: FILE, metadata: { title: "x".repeat(256) } }],
    ["a long description", { action: "create", file: FILE, metadata: { description: "x".repeat(2001) } }],
  ])("refuses %s with 400 invalid_request", async (_what, body) => {
    const client = fakeClient();
    const r = await call(handler(client), body);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_request");
    expect(client.videos.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("answers 405 to anything but POST", async () => {
    const res = await handler(fakeClient())(new Request("https://app.test/api/upload"));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("passes the API's own errors through", async () => {
    const client = fakeClient();
    client.videos.createMultipartUpload.mockRejectedValueOnce(
      new InvalidRequestError({ message: "Hosting is not enabled for this app.", code: "hosting_disabled", httpStatus: 400 }),
    );
    const r = await call(handler(client), { action: "create", file: FILE });
    expect(r).toEqual({ status: 400, body: { error: { code: "hosting_disabled", message: "Hosting is not enabled for this app." } } });

    const h = handler(client);
    const { ticket } = await create(h);
    client.videos.getUploadPartUrls.mockRejectedValueOnce(
      new NotFoundError({ message: "Video not found.", type: "not_found" }),
    );
    const r2 = await call(h, { action: "sign_parts", ticket, part_numbers: [1] });
    expect(r2).toEqual({ status: 502, body: { error: { code: "not_found", message: "Video not found." } } });
  });

  it.each([
    ["a 401", { httpStatus: 401, code: "unauthenticated", type: "unauthenticated" }],
    ["a 403", { httpStatus: 403, code: "permission_denied", type: "permission_denied" }],
    ["permission_denied without a status", { type: "permission_denied" }],
  ])("the server's own API key or app being refused (%s) is not the visitor's 401/403", async (_what, fields) => {
    const client = fakeClient();
    client.videos.createMultipartUpload.mockRejectedValueOnce(
      Object.assign(new InvalidRequestError({ message: "api key has been revoked" }), fields),
    );
    const res = await handler(client)(post({ action: "create", file: FILE }));
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: { code: "internal_error", message: "The upload service is not set up correctly. Try again later." },
    });
    expect(text).not.toContain("revoked");
  });

  it("an API error the visitor can act on keeps its wire code", async () => {
    const client = fakeClient();
    client.videos.createMultipartUpload.mockRejectedValueOnce(
      new InvalidRequestError({ message: "This app only accepts files up to 1 GB.", code: "max_upload_size_exceeded", httpStatus: 400 }),
    );
    const r = await call(handler(client), { action: "create", file: FILE });
    expect(r).toEqual({ status: 400, body: { error: { code: "max_upload_size_exceeded", message: "This app only accepts files up to 1 GB." } } });
  });

  describe("complete after a lost answer", () => {
    const parts = [1, 2, 3].map((n) => ({ part_number: n, etag: "e" }));
    const gone = () => new NotFoundError({ message: "multipart upload not found", code: "not_found", httpStatus: 404 });

    it("succeeds when the video shows the first complete went through", async () => {
      const client = fakeClient();
      const h = handler(client);
      const { ticket } = await create(h);
      client.videos.completeMultipartUpload.mockRejectedValueOnce(gone());
      client.videos.get.mockResolvedValueOnce({ id: "vid_1", status: "processing" });
      const r = await call(h, { action: "complete", ticket, parts });
      expect(r).toEqual({ status: 200, body: { video_id: "vid_1", status: "processing" } });
      expect(client.videos.get).toHaveBeenCalledWith("vid_1");
    });

    it("passes the API error through when the client has no get()", async () => {
      const { get: _get, ...videos } = fakeClient().videos;
      const client = { videos };
      const h = createUploadHandler({ client, secret: SECRET, authorize: () => ({ allow: true }) });
      const { ticket } = await create(h);
      videos.completeMultipartUpload.mockRejectedValueOnce(gone());
      const r = await call(h, { action: "complete", ticket, parts });
      expect(r).toEqual({ status: 404, body: { error: { code: "not_found", message: "multipart upload not found" } } });
    });

    it("passes the real error on when the video is still uploading, or cannot be read", async () => {
      const client = fakeClient();
      const h = handler(client);
      const { ticket } = await create(h);
      client.videos.completeMultipartUpload.mockRejectedValueOnce(gone());
      const r = await call(h, { action: "complete", ticket, parts });
      expect(r).toEqual({ status: 404, body: { error: { code: "not_found", message: "multipart upload not found" } } });
      client.videos.completeMultipartUpload.mockRejectedValueOnce(gone());
      client.videos.get.mockRejectedValueOnce(new Error("down"));
      expect((await call(h, { action: "complete", ticket, parts })).status).toBe(404);
    });
  });

  describe("request shape", () => {
    it.each([undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"])(
      "refuses content-type %j with 415 before authorize runs (a cross-site form needs a preflight)",
      async (type) => {
        const authorize = vi.fn(() => ({ allow: true }) as const);
        const client = fakeClient();
        const res = await handler(client, { authorize })(
          new Request("https://app.test/api/upload", {
            method: "POST",
            ...(type ? { headers: { "content-type": type } } : {}),
            body: JSON.stringify({ action: "create", file: FILE }),
          }),
        );
        expect(res.status).toBe(415);
        expect((await res.json()).error.code).toBe("invalid_request");
        expect(authorize).not.toHaveBeenCalled();
        expect(client.videos.createMultipartUpload).not.toHaveBeenCalled();
      },
    );

    it("accepts application/json with parameters", async () => {
      const res = await handler(fakeClient())(
        new Request("https://app.test/api/upload", {
          method: "POST",
          headers: { "content-type": "Application/JSON; charset=utf-8" },
          body: JSON.stringify({ action: "create", file: FILE }),
        }),
      );
      expect(res.status).toBe(200);
    });

    it("refuses a declared body over 1 MiB with 413 before reading it", async () => {
      const authorize = vi.fn(() => ({ allow: true }) as const);
      const res = await handler(fakeClient(), { authorize })(
        new Request("https://app.test/api/upload", {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": String(2 * MiB) },
          body: "{}",
        }),
      );
      expect(res.status).toBe(413);
      expect((await res.json()).error.code).toBe("payload_too_large");
      expect(authorize).not.toHaveBeenCalled();
    });

    it("stops reading a streamed body as soon as it passes 1 MiB", async () => {
      const authorize = vi.fn(() => ({ allow: true }) as const);
      let pulled = 0;
      const chunk = new Uint8Array(64 * 1024).fill(32);
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += chunk.length;
          c.enqueue(chunk);
          if (pulled >= 100 * MiB) c.close();
        },
      });
      const res = await handler(fakeClient(), { authorize })(
        new Request("https://app.test/api/upload", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          duplex: "half",
        } as RequestInit),
      );
      expect(res.status).toBe(413);
      expect(pulled).toBeLessThan(2 * MiB);
      expect(authorize).not.toHaveBeenCalled();
    });

    it("judges a file the browser could not type by its extension, and tells the API", async () => {
      const client = fakeClient();
      const r = await call(handler(client), { action: "create", file: { ...FILE, name: "lecture.mkv", type: "" } });
      expect(r.status).toBe(200);
      expect(client.videos.createMultipartUpload.mock.calls[0]![0]).toMatchObject({ contentType: "video/x-matroska" });
    });
  });

  it("masks every other error as internal_error", async () => {
    const leaks = [
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:443 ak_live_secret"), { code: "ECONNREFUSED" }),
      new TypeError("Cannot read properties of undefined"),
      "a string",
    ];
    for (const leak of leaks) {
      const client = fakeClient();
      client.videos.createMultipartUpload.mockRejectedValueOnce(leak);
      const res = await handler(client)(post({ action: "create", file: FILE }));
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({
        error: { code: "internal_error", message: "The upload server hit an error. Try again in a moment." },
      });
      expect(text).not.toMatch(/ECONNREFUSED|10\.0\.0\.7|ak_live|undefined/);
    }
    const throwing = handler(fakeClient(), {
      authorize: () => {
        throw new Error("db password wrong");
      },
    });
    const r = await call(throwing, { action: "create", file: FILE });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("password");
  });
});
