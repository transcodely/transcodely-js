/**
 * `@transcodely/sdk/upload/server`: the backend half of browser uploads.
 *
 * `createUploadHandler` turns a server-side Transcodely client into one
 * `POST` route the browser uploader talks to. The browser never sees an API
 * key, a video id it can choose, or an upload id it can forge: `create` hands
 * back a signed, short-lived ticket, and every later call acts only on the
 * upload that ticket names. Plain `Request` in, `Response` out, so it runs on
 * Node 20+, edge runtimes and any framework with Web-standard handlers.
 *
 * @example
 * ```ts
 * // app/api/transcodely/upload/route.ts
 * import { createUploadHandler } from "@transcodely/sdk/upload/server";
 *
 * export const POST = createUploadHandler({
 *   client,
 *   authorize: async (req) => {
 *     const user = await currentUser(req);
 *     if (!user) return { allow: false, status: 401 };
 *     return { allow: true, subject: user.id, defaults: { visibility: "private", tags: [`user:${user.id}`] } };
 *   },
 * });
 * ```
 */

import type { PartialMessage } from "@bufbuild/protobuf";

import type { CreateMultipartUploadRequest } from "@transcodely/sdk";
import { MAX_FILE_SIZE, acceptsFile, formatBytes, partSizeFor, partsFor, videoTypeFor } from "./index.js";
import type { UploadRequest, WireFile } from "./index.js";

/** What `authorize` may set on every upload. The file's own facts are not among them. */
export type UploadDefaults = Omit<
  PartialMessage<CreateMultipartUploadRequest>,
  "filename" | "contentType" | "sizeBytes" | "totalParts" | "partSizeBytes"
>;

export type UploadAction = UploadRequest["action"];

export interface AuthorizeContext {
  action: UploadAction;
  /** The file the browser wants to upload; `create` only. */
  file?: WireFile;
}

export type AuthorizeResult =
  | { allow: false; message?: string; status?: 401 | 403 }
  | {
      allow: true;
      /**
       * Who is uploading (a user id). Strongly recommended. It is bound into the
       * ticket, and every later call must return the same subject or is refused.
       *
       * Without it, tickets belong to no one: on a shared browser profile, if
       * user A starts uploading a file, signs out, and user B signs in and picks
       * the same file, B's browser resumes A's upload and completes A's video,
       * created with A's `defaults`. Set `subject` and B starts a fresh upload.
       */
      subject?: string;
      /** Applied on `create`, after the browser's title and description, so these always win. */
      defaults?: UploadDefaults;
    };

interface Timestamp {
  seconds: bigint;
  nanos: number;
}
interface PartUrls {
  parts: { partNumber: number; uploadUrl: string }[];
  urlsExpireAt?: Timestamp;
}

/** The four VideoService calls the handler drives; a `Transcodely` client fits. */
export interface UploadHandlerClient {
  videos: {
    createMultipartUpload(
      req: PartialMessage<CreateMultipartUploadRequest>,
    ): Promise<PartUrls & { video?: { id: string }; uploadId: string }>;
    getUploadPartUrls(req: { id: string; uploadId: string; partNumbers: number[] }): Promise<PartUrls>;
    completeMultipartUpload(req: {
      id: string;
      uploadId: string;
      parts: { partNumber: number; etag: string }[];
    }): Promise<{ video?: { id: string; status: string } }>;
    abortMultipartUpload(req: { id: string; uploadId: string }): Promise<unknown>;
    /** Used to tell a lost `complete` answer from a real failure. */
    get(id: string): Promise<{ id: string; status: string }>;
  };
}

export interface UploadHandlerOptions {
  client: UploadHandlerClient;
  /**
   * Required. Runs on every call (`create`, `sign_parts`, `complete`, `abort`),
   * before anything is created or signed; check the user's session here and
   * return their id as `subject`. A refusal creates nothing.
   *
   * The handler only accepts `Content-Type: application/json`, so a page on
   * another site cannot post to it without a CORS preflight. Cookies with
   * `SameSite=None` still reach it after one, so check `Origin` here too if
   * your app answers cross-origin requests.
   */
  authorize: (request: Request, ctx: AuthorizeContext) => AuthorizeResult | Promise<AuthorizeResult>;
  /** Signs tickets; at least 32 characters. Default `process.env.TRANSCODELY_UPLOAD_SECRET`. */
  secret?: string;
  /** Largest file accepted, in bytes. Default and ceiling 5 GiB. */
  maxFileSize?: number;
  /** Same syntax as `<input accept>`. Default `"video/*"`. */
  accept?: string;
  /** How long a browser may keep resuming one upload. Default 86,400 (24 h), between 60 and 518,400 (6 days). */
  ticketTtlSeconds?: number;
}

interface Ticket {
  v: 1;
  vid: string;
  uid: string;
  tp: number;
  ps: number;
  sz: number;
  sub: string | null;
  exp: number;
}

const enc = new TextEncoder();
const b64 = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const iso = (t: Timestamp | undefined) =>
  new Date(t ? Number(t.seconds) * 1000 + Math.floor(t.nanos / 1e6) : Date.now() + 3_000_000).toISOString();
const wireParts = (r: PartUrls) => ({
  parts: r.parts.map((p) => ({ part_number: p.partNumber, url: p.uploadUrl })),
  urls_expire_at: iso(r.urlsExpireAt),
});
const isInt = (n: unknown, lo: number, hi: number): n is number =>
  Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;
const isStr = (s: unknown, max: number): s is string => typeof s === "string" && [...s].length <= max;

/** Video statuses that mean the bytes are in and `complete` already ran. */
const COMPLETED = ["processing", "ready", "error", "archived"];
/** Largest request body read; a 10,000-part `complete` is about 700 KB. */
const MAX_BODY = 1 << 20;

class Refusal {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly message: string,
  ) {}
}
const invalid = (message: string) => new Refusal(400, "invalid_request", message);
const badTicket = () =>
  new Refusal(403, "ticket_invalid", "This upload belongs to a different session. Start the upload again.");

const json = (status: number, body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

/**
 * A Transcodely API error, recognised by shape rather than `instanceof` so a
 * second copy of the SDK in the bundle still maps. A plain Node error (which
 * may carry a string `code` and a message naming a host) never matches: it
 * needs a numeric `httpStatus`, or the SDK's `type` and `errors` pair.
 */
function apiError(e: unknown): Refusal | undefined {
  if (!e || typeof e !== "object") return undefined;
  const { code, type, message, httpStatus, errors } = e as Record<string, unknown>;
  const c = typeof code === "string" && code ? code : typeof type === "string" && type ? type : undefined;
  const http = typeof httpStatus === "number";
  if (!c || typeof message !== "string" || !(http || (typeof type === "string" && Array.isArray(errors)))) {
    return undefined;
  }
  // The server's own API key or app is the problem, not the visitor: do not
  // tell the browser to sign in, and do not describe the key's state to it.
  if (httpStatus === 401 || httpStatus === 403 || type === "unauthenticated" || type === "permission_denied") {
    return new Refusal(500, "internal_error", "The upload service is not set up correctly. Try again later.");
  }
  return new Refusal(http && httpStatus >= 400 && httpStatus <= 599 ? httpStatus : 502, c, message);
}

/** The body as text, refusing (413) as soon as it passes `MAX_BODY`, before it is all in memory. */
async function readCapped(request: Request): Promise<string> {
  const tooBig = () => new Refusal(413, "payload_too_large", "The request body is too large.");
  if (Number(request.headers.get("content-length")) > MAX_BODY) throw tooBig();
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const r = await reader?.read();
    if (!r || r.done) break;
    n += r.value.length;
    if (n > MAX_BODY) {
      await reader!.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(r.value);
  }
  const all = new Uint8Array(n);
  chunks.reduce((at, c) => (all.set(c, at), at + c.length), 0);
  return new TextDecoder().decode(all);
}

/** Builds the `POST` handler the browser uploader talks to. */
export function createUploadHandler(opts: UploadHandlerOptions): (request: Request) => Promise<Response> {
  const { client, authorize } = opts;
  if (typeof authorize !== "function") {
    throw new Error(
      "createUploadHandler needs an `authorize` function that decides who may upload. Return { allow: true } to let a request through, or { allow: false } to refuse it.",
    );
  }
  const secret =
    opts.secret ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.TRANSCODELY_UPLOAD_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "createUploadHandler needs a secret of at least 32 characters to sign upload tickets. Set TRANSCODELY_UPLOAD_SECRET (for example to the output of `openssl rand -hex 32`) or pass { secret }.",
    );
  }
  const maxSize = Math.min(opts.maxFileSize ?? MAX_FILE_SIZE, MAX_FILE_SIZE);
  const accept = opts.accept ?? "video/*";
  const ttl = Math.min(518_400, Math.max(60, opts.ticketTtlSeconds ?? 86_400));
  let key: Promise<CryptoKey> | undefined;
  const hmac = () =>
    (key ??= crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]));

  const sign = async (t: Ticket) => {
    const body = b64(enc.encode(JSON.stringify(t)));
    return `${body}.${b64(new Uint8Array(await crypto.subtle.sign("HMAC", await hmac(), enc.encode(body))))}`;
  };

  const verify = async (raw: unknown, subject: string | null): Promise<Ticket> => {
    if (typeof raw !== "string" || raw.length > 4096) throw badTicket();
    const [body, sig, extra] = raw.split(".");
    let t: Ticket;
    try {
      if (!body || !sig || extra !== undefined) throw new Error("bad ticket");
      if (!(await crypto.subtle.verify("HMAC", await hmac(), unb64(sig), enc.encode(body)))) throw new Error("bad ticket");
      t = JSON.parse(new TextDecoder().decode(unb64(body))) as Ticket;
    } catch {
      throw badTicket();
    }
    if (t.v !== 1 || !isInt(t.tp, 1, 10_000) || typeof t.vid !== "string" || typeof t.uid !== "string") {
      throw badTicket();
    }
    if (!(t.exp * 1000 > Date.now())) {
      throw new Refusal(410, "upload_expired", "This upload has expired. Start it again.");
    }
    if (t.sub !== subject) throw badTicket();
    return t;
  };

  const handle = async (request: Request, b: Record<string, unknown>): Promise<unknown> => {
    const action = b.action;
    if (action !== "create" && action !== "sign_parts" && action !== "complete" && action !== "abort") {
      throw invalid("`action` must be one of create, sign_parts, complete or abort.");
    }
    let file: WireFile | undefined;
    if (action === "create") {
      const f = b.file as Record<string, unknown> | undefined;
      if (
        !f || typeof f !== "object" || !isStr(f.name, 255) || !f.name || !isInt(f.size, 0, Number.MAX_SAFE_INTEGER) ||
        !isStr(f.type, 255) || (f.last_modified !== undefined && typeof f.last_modified !== "number")
      ) {
        throw invalid("`file` must have a name (up to 255 characters), a size in bytes and a type.");
      }
      file = { name: f.name, size: f.size, type: f.type || videoTypeFor(f.name), ...(f.last_modified !== undefined ? { last_modified: f.last_modified } : {}) };
    }

    const auth = await authorize(request, { action, ...(file ? { file } : {}) });
    if (!auth?.allow) {
      const unauth = auth?.status === 401;
      throw new Refusal(
        unauth ? 401 : 403,
        unauth ? "unauthenticated" : "forbidden",
        auth?.message || (unauth ? "Sign in to upload." : "This upload was refused."),
      );
    }
    const subject = auth.subject ?? null;
    const v = client.videos;

    if (file) {
      if (file.size < 1) throw invalid("The file is empty.");
      if (file.size > maxSize) {
        throw new Refusal(413, "file_too_large", `This file is ${formatBytes(file.size)}. The largest file you can upload is ${formatBytes(maxSize)}.`);
      }
      if (!acceptsFile(file, accept)) {
        throw new Refusal(415, "file_type_not_accepted", `${file.name} is not a type of file this uploader accepts (${accept}).`);
      }
      const m = (b.metadata ?? {}) as Record<string, unknown>;
      if (typeof m !== "object" || (m.title !== undefined && !isStr(m.title, 255)) || (m.description !== undefined && !isStr(m.description, 2000))) {
        throw invalid("`metadata.title` must be text up to 255 characters and `metadata.description` up to 2,000.");
      }
      const ps = partSizeFor(file.size);
      const tp = partsFor(file.size, ps);
      const res = await v.createMultipartUpload({
        ...(m.title !== undefined ? { title: m.title as string } : {}),
        ...(m.description !== undefined ? { description: m.description as string } : {}),
        ...auth.defaults,
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: BigInt(file.size),
        totalParts: tp,
        partSizeBytes: BigInt(ps),
      });
      const vid = res.video?.id;
      if (!vid || !res.uploadId) throw new Error("CreateMultipartUpload returned no video or upload id");
      const exp = Math.floor(Date.now() / 1000) + ttl;
      const ticket = await sign({ v: 1, vid, uid: res.uploadId, tp, ps, sz: file.size, sub: subject, exp });
      return {
        ticket,
        video_id: vid,
        upload_id: res.uploadId,
        part_size: ps,
        total_parts: tp,
        expires_at: new Date(exp * 1000).toISOString(),
        ...wireParts(res),
      };
    }

    const t = await verify(b.ticket, subject);
    const ids = { id: t.vid, uploadId: t.uid };
    if (action === "sign_parts") {
      const nums = b.part_numbers;
      if (
        !Array.isArray(nums) || !nums.length || nums.length > 100 ||
        !nums.every((n) => isInt(n, 1, t.tp)) || new Set(nums).size !== nums.length
      ) {
        throw invalid(`\`part_numbers\` must list 1 to 100 different part numbers between 1 and ${String(t.tp)}.`);
      }
      return wireParts(await v.getUploadPartUrls({ ...ids, partNumbers: nums as number[] }));
    }
    if (action === "complete") {
      const ps = b.parts as { part_number?: unknown; etag?: unknown }[];
      const seen = new Set<unknown>();
      if (
        !Array.isArray(ps) || ps.length !== t.tp ||
        !ps.every((p) => p && isInt(p.part_number, 1, t.tp) && isStr(p.etag, 1024) && p.etag && !seen.has(p.part_number) && seen.add(p.part_number))
      ) {
        throw invalid(`\`parts\` must list each of the ${String(t.tp)} parts exactly once, with its ETag.`);
      }
      let video: { id: string; status: string } | undefined;
      try {
        video = (
          await v.completeMultipartUpload({
            ...ids,
            parts: ps
              .map((p) => ({ partNumber: p.part_number as number, etag: p.etag as string }))
              .sort((a, c) => a.partNumber - c.partNumber),
          })
        ).video;
      } catch (e) {
        // A retry after a lost answer: the first complete went through, and
        // the API no longer knows this upload id. The video says it is done.
        const got = await v.get(t.vid).catch(() => undefined);
        if (!got || !COMPLETED.includes(got.status)) throw e;
        video = got;
      }
      return { video_id: video?.id || t.vid, status: video?.status ?? "" };
    }
    await v.abortMultipartUpload(ids);
    return {};
  };

  return async (request) => {
    if (request.method !== "POST") {
      return json(405, { error: { code: "method_not_allowed", message: "Use POST." } }, { allow: "POST" });
    }
    try {
      if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
        throw new Refusal(415, "invalid_request", "Send the request as JSON, with Content-Type: application/json.");
      }
      let body: unknown;
      try {
        body = JSON.parse(await readCapped(request));
      } catch (e) {
        if (e instanceof Refusal) throw e;
        throw invalid("The request body must be JSON.");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("The request body must be a JSON object.");
      return json(200, await handle(request, body as Record<string, unknown>));
    } catch (e) {
      const r = e instanceof Refusal ? e : apiError(e);
      return r
        ? json(r.status, { error: { code: r.code, message: r.message } })
        : json(500, { error: { code: "internal_error", message: "The upload server hit an error. Try again in a moment." } });
    }
  };
}
