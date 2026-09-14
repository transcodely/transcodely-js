/**
 * A mock Transcodely + S3 origin for upload tests.
 *
 * One `node:http` server plays two roles at once:
 *
 *   - the Connect-RPC API (`POST /transcodely.v1.VideoService/<Method>`),
 *     speaking the same snake_case JSON the real API speaks, and
 *   - the object store the presigned URLs point at (`PUT /s3/...`), which
 *     records every part body it receives and answers with an `ETag`.
 *
 * Because the presigned URLs it hands out point back at itself, `putFile`
 * runs its real network path end to end — no fetch stubbing.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { AddressInfo } from "node:net";

export interface RecordedPut {
  /** Part number parsed out of the presigned path; 0 for a single-PUT upload. */
  partNumber: number;
  body: Buffer;
  contentType: string | undefined;
  /** 1-based attempt counter for this part (2 means the first try was retried). */
  attempt: number;
}

export interface RpcCall {
  method: string;
  body: any;
}

export interface MockBehaviour {
  /**
   * Per-part failure script. `failures[3] = [500, 500]` makes part 3 answer
   * 500 twice before succeeding. `403` is the expired-presigned-URL case.
   */
  failures?: Record<number, number[]>;
  /** Parts whose response omits the ETag header. */
  omitEtagFor?: number[];
  /** Parts CreateMultipartUpload/GetUploadPartUrls refuse to issue a URL for. */
  emptyPartUrlsFor?: number[];
  /** Hook fired after every recorded PUT — used to trigger an abort mid-flight. */
  onPut?: (put: RecordedPut) => void | Promise<void>;
  /** RPC methods that should answer a Connect error instead of a result. */
  rpcErrors?: Record<string, { status: number; code: string; message: string }>;
}

export interface MockServer {
  baseUrl: string;
  /** Every PUT the object store saw, in arrival order. */
  puts: RecordedPut[];
  /** Every Connect RPC the API saw, in arrival order. */
  calls: RpcCall[];
  /**
   * PUTs and RPCs interleaved in arrival order (`put:3`, `rpc:CompleteMultipartUpload`),
   * so a test can assert that nothing was still uploading after the abort went out.
   */
  timeline: string[];
  /** Part number → the URLs handed out for it, in the order they were issued. */
  issuedUrls: Map<number, string[]>;
  close(): Promise<void>;
}

const VIDEO_ID = "vid_a1b2c3d4e5f6g7";
const UPLOAD_ID = "s3-upload-id-0001";

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

function video(status = "uploading"): Record<string, unknown> {
  return {
    id: VIDEO_ID,
    app_id: "app_k1l2m3n4o5",
    source: "upload",
    status,
    visibility: "unlisted",
  };
}

export async function startMockServer(behaviour: MockBehaviour = {}): Promise<MockServer> {
  const puts: RecordedPut[] = [];
  const calls: RpcCall[] = [];
  const timeline: string[] = [];
  const issuedUrls = new Map<number, string[]>();
  const attempts = new Map<number, number>();
  const failures: Record<number, number[]> = {};
  for (const [k, v] of Object.entries(behaviour.failures ?? {})) failures[Number(k)] = [...v];

  let base = "";

  function partUrl(partNumber: number): string {
    // A fresh nonce per issue so a test can prove a URL was actually re-issued.
    const nonce = createHash("sha256")
      .update(`${String(partNumber)}:${String((issuedUrls.get(partNumber) ?? []).length)}`)
      .digest("hex")
      .slice(0, 8);
    const url = `${base}/s3/part/${String(partNumber)}?sig=${nonce}`;
    issuedUrls.set(partNumber, [...(issuedUrls.get(partNumber) ?? []), url]);
    return url;
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", base || "http://localhost");
      const body = await readBody(req);

      if (req.method === "PUT" && url.pathname.startsWith("/s3/")) {
        const partNumber = url.pathname.startsWith("/s3/part/")
          ? Number(url.pathname.slice("/s3/part/".length))
          : 0;
        const attempt = (attempts.get(partNumber) ?? 0) + 1;
        attempts.set(partNumber, attempt);
        const record: RecordedPut = {
          partNumber,
          body,
          contentType: req.headers["content-type"],
          attempt,
        };
        puts.push(record);
        timeline.push(`put:${String(partNumber)}`);
        await behaviour.onPut?.(record);

        const scripted = failures[partNumber]?.shift();
        if (scripted !== undefined) {
          res.writeHead(scripted, { "content-type": "text/plain" });
          res.end("scripted failure");
          return;
        }
        const headers: Record<string, string> = {};
        if (!behaviour.omitEtagFor?.includes(partNumber)) {
          headers.etag = `"${createHash("md5").update(body).digest("hex")}"`;
        }
        res.writeHead(200, headers);
        res.end();
        return;
      }

      // Connect-RPC surface.
      const method = url.pathname.split("/").pop() ?? "";
      const parsed: any = body.length > 0 ? JSON.parse(body.toString("utf8")) : {};
      calls.push({ method, body: parsed });
      timeline.push(`rpc:${method}`);

      const scriptedErr = behaviour.rpcErrors?.[method];
      if (scriptedErr) {
        json(res, scriptedErr.status, {
          code: scriptedErr.code,
          message: scriptedErr.message,
        });
        return;
      }

      switch (method) {
        case "CreateUpload":
          json(res, 200, {
            video: video(),
            upload_url: `${base}/s3/single`,
            upload_expires_at: "2099-01-01T00:00:00Z",
          });
          return;
        case "CompleteUpload":
          json(res, 200, { video: video("processing") });
          return;
        case "CreateMultipartUpload": {
          const total = Number(parsed.total_parts ?? 0);
          // The real API returns URLs for the first 50 parts only.
          const first = Math.min(total, 50);
          const parts = Array.from({ length: first }, (_, i) => i + 1)
            .filter((n) => !behaviour.emptyPartUrlsFor?.includes(n))
            .map((n) => ({ part_number: n, upload_url: partUrl(n) }));
          json(res, 200, {
            video: video(),
            upload_id: UPLOAD_ID,
            parts,
            urls_expire_at: "2099-01-01T00:00:00Z",
          });
          return;
        }
        case "GetUploadPartUrls": {
          const numbers: number[] = (parsed.part_numbers ?? []).map(Number);
          json(res, 200, {
            parts: numbers
              .filter((n) => !behaviour.emptyPartUrlsFor?.includes(n))
              .map((n) => ({ part_number: n, upload_url: partUrl(n) })),
            urls_expire_at: "2099-01-01T00:00:00Z",
          });
          return;
        }
        case "CompleteMultipartUpload":
          json(res, 200, { video: video("processing") });
          return;
        case "AbortMultipartUpload":
          json(res, 200, {});
          return;
        default:
          json(res, 404, { code: "not_found", message: `no mock for ${method}` });
          return;
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${String(port)}`;

  return {
    baseUrl: base,
    puts,
    calls,
    timeline,
    issuedUrls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const MOCK_VIDEO_ID = VIDEO_ID;
export const MOCK_UPLOAD_ID = UPLOAD_ID;
