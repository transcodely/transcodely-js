/**
 * A mock Transcodely API for the CLI tests: the Connect-RPC surface the CLI
 * actually calls, plus the presigned PUT endpoint an upload lands on. Speaks
 * the real wire format — snake_case fields, lowercase enums, length-prefixed
 * envelopes for the Watch streams — so the SDK's own codec is exercised, not
 * stubbed.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RpcCall {
  method: string;
  body: any;
  authorization: string | undefined;
}

export interface MockApiOptions {
  /** Status the video/job reports when first created. */
  createdStatus?: string;
  /** Sequence of statuses a Watch stream emits, ending the stream after the last. */
  watchStatuses?: string[];
  /** Answer this method with a Connect error instead of a result. */
  errors?: Record<string, { status: number; code: string; message: string }>;
  /** Jobs returned by JobService/List. */
  jobs?: Record<string, unknown>[];
}

export interface MockApi {
  baseUrl: string;
  calls: RpcCall[];
  puts: { url: string; size: number }[];
  close(): Promise<void>;
}

export const VIDEO_ID = "vid_a1b2c3d4e5f6g7";
export const JOB_ID = "job_a1b2c3d4e5f6";

export function videoJson(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VIDEO_ID,
    app_id: "app_k1l2m3n4o5",
    source: "upload",
    status,
    visibility: "unlisted",
    ...extra,
  };
}

export function jobJson(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID,
    app_id: "app_k1l2m3n4o5",
    input_url: "https://example.com/source.mp4",
    status,
    progress: status === "completed" ? 100 : 0,
    priority: "normal",
    outputs: [],
    ...extra,
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Connect envelope: 1 flag byte, 4-byte big-endian length, then the payload. */
function envelope(flags: number, payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const head = Buffer.alloc(5);
  head.writeUInt8(flags, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

export async function startMockApi(opts: MockApiOptions = {}): Promise<MockApi> {
  const calls: RpcCall[] = [];
  const puts: { url: string; size: number }[] = [];
  let base = "";

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const path = (req.url ?? "/").split("?")[0] ?? "/";

      if (req.method === "PUT" && path.startsWith("/s3/")) {
        puts.push({ url: path, size: body.length });
        res.writeHead(200, { etag: '"d41d8cd98f00b204e9800998ecf8427e"' });
        res.end();
        return;
      }

      const method = path.split("/").pop() ?? "";
      const parsed: any =
        req.headers["content-type"] === "application/connect+json"
          ? JSON.parse(body.subarray(5).toString("utf8") || "{}")
          : JSON.parse(body.toString("utf8") || "{}");
      calls.push({ method, body: parsed, authorization: req.headers.authorization });

      const scripted = opts.errors?.[method];
      if (scripted) {
        res.writeHead(scripted.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: scripted.code, message: scripted.message }));
        return;
      }

      const send = (payload: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      const stream = (frames: string[]): void => {
        res.writeHead(200, { "content-type": "application/connect+json" });
        for (const f of frames) res.write(envelope(0, f));
        res.end(envelope(2, "{}"));
      };

      const created = opts.createdStatus ?? "processing";

      switch (method) {
        case "CreateFromUrl":
          send({ video: videoJson(created) });
          return;
        case "CreateUpload":
          send({
            video: videoJson("uploading"),
            upload_url: `${base}/s3/single`,
            upload_expires_at: "2099-01-01T00:00:00Z",
          });
          return;
        case "CompleteUpload":
          send({ video: videoJson(created) });
          return;
        case "Create":
          send({ job: jobJson(created === "processing" ? "pending" : created) });
          return;
        case "Get":
          // Both services expose Get; the request tells them apart.
          if (typeof parsed.id === "string" && parsed.id.startsWith("job_")) {
            send({ job: jobJson("completed", { progress: 100 }) });
          } else {
            send({
              video: videoJson("ready", {
                playback_url: "https://play.transcodely.com/v/vid_a1b2c3d4e5f6g7",
                renditions: [{ id: "ren_1", resolution: "1080p", codec: "h264", bitrate_kbps: 5000 }],
              }),
            });
          }
          return;
        case "List":
          send({
            jobs: opts.jobs ?? [jobJson("completed", { progress: 100 })],
            pagination: { total_count: (opts.jobs ?? [1]).length },
          });
          return;
        case "Watch": {
          const statuses = opts.watchStatuses ?? ["ready"];
          const isJob = typeof parsed.id === "string" && parsed.id.startsWith("job_");
          stream(
            statuses.map((s) =>
              isJob
                ? JSON.stringify({ job: jobJson(s, { progress: s === "completed" ? 100 : 40 }), event: "progress" })
                : JSON.stringify({ video: videoJson(s), event_type: "status" }),
            ),
          );
          return;
        }
        default:
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "not_found", message: `no mock for ${method}` }));
          return;
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${String(port)}`;

  return {
    baseUrl: base,
    calls,
    puts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
