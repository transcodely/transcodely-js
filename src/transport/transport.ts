/**
 * Hand-rolled Connect-RPC HTTP transport.
 *
 * Why not @connectrpc/connect-node? Connect-ES doesn't expose a hook for
 * swapping the JSON codec, but Transcodely's wire format requires
 * snake_case + simplified-enum JSON. Owning the transport gives us control
 * end-to-end with ~200 LoC.
 *
 * Wire format reference:
 *   - Unary: POST {baseUrl}/{service.fullName}/{method.name}
 *            Content-Type: application/json
 *            body: JSON-encoded request
 *   - Server-streaming: same URL, Content-Type: application/connect+json
 *            body: length-prefixed enveloped frames
 *            stream ends with an end-stream frame (flag bit 0x02)
 */

import type { Message, MessageType } from "@bufbuild/protobuf";
import { MethodKind } from "@bufbuild/protobuf";

import { TranscodelyError } from "../errors.js";
import { API_VERSION, DEFAULT_BASE_URL, SDK_VERSION } from "../version.js";

import { deserialize, serialize } from "../codec/json.js";
import {
  connectionError,
  mapHttpError,
} from "./error-mapping.js";
import {
  clientUserAgentJson,
  userAgent,
  uuidv4,
} from "./headers.js";

export interface Service {
  typeName: string;
  methods: Record<
    string,
    {
      name: string;
      I: MessageType;
      O: MessageType;
      kind: MethodKind;
    }
  >;
}

export interface TransportConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  apiVersion?: string;
  defaultHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Logger called on each request lifecycle event (success or error). */
  logger?: (event: LogEvent) => void;
}

export interface LogEvent {
  service: string;
  method: string;
  durationMs: number;
  attempt: number;
  status?: number;
  requestId?: string;
  error?: TranscodelyError;
}

export interface CallOptions {
  /** Per-call timeout override (ms). */
  timeoutMs?: number;
  /** Per-call max retries override. */
  maxRetries?: number;
  /** AbortSignal to cancel an in-flight request or stream. */
  signal?: AbortSignal;
  /** Custom Idempotency-Key header (else SDK generates one for non-streaming writes). */
  idempotencyKey?: string;
  /** Per-call API version override. */
  apiVersion?: string;
  /** Extra headers to merge into the request. */
  headers?: Record<string, string>;
}

export class Transport {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly apiVersion: string;
  readonly defaultHeaders: Record<string, string>;
  readonly fetchImpl: typeof fetch;
  readonly logger: ((event: LogEvent) => void) | undefined;

  /** ID of the most recent successful (or failed) request, Stripe-style. */
  lastRequestId: string | undefined;

  constructor(cfg: TransportConfig) {
    if (!cfg.apiKey) throw new Error("Transcodely: apiKey is required");
    this.apiKey = cfg.apiKey;
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.apiVersion = cfg.apiVersion ?? API_VERSION;
    this.defaultHeaders = cfg.defaultHeaders ?? {};
    this.fetchImpl = cfg.fetchImpl ?? fetch.bind(globalThis);
    this.logger = cfg.logger;
  }

  /** Invoke a unary RPC and return the parsed response message. */
  async unary<I extends Message<I>, O extends Message<O>>(
    service: Service,
    method: { name: string; I: MessageType<I>; O: MessageType<O>; kind: MethodKind },
    request: I,
    opts: CallOptions = {},
  ): Promise<O> {
    if (method.kind !== MethodKind.Unary) {
      throw new Error(`unary() called for non-unary method ${method.name}`);
    }
    const url = `${this.baseUrl}/${service.typeName}/${method.name}`;
    const body = serialize(request, method.I);
    const isWrite = !method.name.startsWith("Get") && !method.name.startsWith("List") && method.name !== "Watch";
    const idempotencyKey = isWrite ? opts.idempotencyKey ?? uuidv4() : undefined;

    return this.withRetry(service.typeName, method.name, opts, async (attempt) => {
      const headers = this.buildHeaders(opts, "application/json", idempotencyKey);
      const ac = this.linkAbort(opts);
      const started = Date.now();
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body: body as unknown as BodyInit,
          signal: ac.signal,
        });
      } catch (err) {
        ac.cleanup();
        throw connectionError(err);
      }
      ac.cleanup();
      this.lastRequestId = response.headers.get("x-request-id") ?? this.lastRequestId;
      this.emit({
        service: service.typeName,
        method: method.name,
        attempt,
        durationMs: Date.now() - started,
        status: response.status,
        requestId: this.lastRequestId,
      });
      const buf = new Uint8Array(await response.arrayBuffer());
      if (!response.ok) {
        const text = new TextDecoder().decode(buf);
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* keep as text */
        }
        throw mapHttpError({ status: response.status, body, headers: response.headers });
      }
      return deserialize(buf, method.O);
    });
  }

  /** Invoke a server-streaming RPC and yield each response message. */
  async *stream<I extends Message<I>, O extends Message<O>>(
    service: Service,
    method: { name: string; I: MessageType<I>; O: MessageType<O>; kind: MethodKind },
    request: I,
    opts: CallOptions = {},
  ): AsyncIterable<O> {
    if (method.kind !== MethodKind.ServerStreaming) {
      throw new Error(`stream() called for non-streaming method ${method.name}`);
    }
    const url = `${this.baseUrl}/${service.typeName}/${method.name}`;
    const headers = this.buildHeaders(opts, "application/connect+json");
    const body = encodeEnvelope(0, serialize(request, method.I));
    const ac = this.linkAbort(opts);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: body as unknown as BodyInit,
        signal: ac.signal,
      });
    } catch (err) {
      ac.cleanup();
      throw connectionError(err);
    }
    this.lastRequestId = response.headers.get("x-request-id") ?? this.lastRequestId;

    if (!response.ok) {
      ac.cleanup();
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep */
      }
      throw mapHttpError({
        status: response.status,
        body: parsed,
        headers: response.headers,
      });
    }
    if (!response.body) {
      ac.cleanup();
      throw connectionError(new Error("server returned no body for streaming response"));
    }
    try {
      for await (const frame of readEnvelopes(response.body)) {
        if ((frame.flags & 0x02) !== 0) {
          // End-stream frame: the payload is a JSON object that may contain `error`.
          const text = new TextDecoder().decode(frame.data);
          if (text.length === 0) return;
          let parsed: { error?: { code?: string; message?: string } } = {};
          try {
            parsed = JSON.parse(text);
          } catch {
            /* ignore */
          }
          if (parsed.error) {
            throw mapHttpError({
              status: 400,
              body: parsed.error,
              headers: response.headers,
            });
          }
          return;
        }
        yield deserialize(frame.data, method.O);
      }
    } finally {
      ac.cleanup();
    }
  }

  private buildHeaders(
    opts: CallOptions,
    contentType: string,
    idempotencyKey?: string,
  ): Headers {
    const h = new Headers();
    h.set("content-type", contentType);
    h.set("connect-protocol-version", "1");
    h.set("authorization", `Bearer ${this.apiKey}`);
    h.set("user-agent", userAgent());
    h.set("x-transcodely-client-user-agent", clientUserAgentJson());
    h.set("transcodely-version", opts.apiVersion ?? this.apiVersion);
    h.set("accept", contentType);
    if (idempotencyKey) h.set("idempotency-key", idempotencyKey);
    for (const [k, v] of Object.entries(this.defaultHeaders)) h.set(k, v);
    for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, v);
    return h;
  }

  private linkAbort(opts: CallOptions): { signal: AbortSignal; cleanup: () => void } {
    const ac = new AbortController();
    const timeout = opts.timeoutMs ?? this.timeoutMs;
    const handles: Array<() => void> = [];
    if (timeout > 0) {
      const t = setTimeout(() => ac.abort(new Error(`request timed out after ${timeout}ms`)), timeout);
      handles.push(() => clearTimeout(t));
    }
    if (opts.signal) {
      const onAbort = () => ac.abort(opts.signal!.reason);
      if (opts.signal.aborted) ac.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", onAbort);
      handles.push(() => opts.signal!.removeEventListener("abort", onAbort));
    }
    return { signal: ac.signal, cleanup: () => handles.forEach((fn) => fn()) };
  }

  private emit(ev: LogEvent): void {
    if (this.logger) {
      try {
        this.logger(ev);
      } catch {
        /* never let logger errors break the request path */
      }
    }
  }

  private async withRetry<T>(
    service: string,
    method: string,
    opts: CallOptions,
    fn: (attempt: number) => Promise<T>,
  ): Promise<T> {
    const max = opts.maxRetries ?? this.maxRetries;
    let lastError: unknown;
    for (let attempt = 1; attempt <= max + 1; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastError = err;
        if (attempt > max || !isRetryable(err)) {
          if (err instanceof TranscodelyError) {
            this.emit({
              service,
              method,
              attempt,
              durationMs: 0,
              status: err.httpStatus,
              requestId: err.requestId,
              error: err,
            });
          }
          throw err;
        }
        await sleepBackoff(attempt, err);
      }
    }
    throw lastError;
  }
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof TranscodelyError)) return false;
  if (err.constructor.name === "APIConnectionError") return true;
  if (err.constructor.name === "RateLimitError") return true;
  if (err.httpStatus !== undefined && err.httpStatus >= 500) return true;
  return false;
}

async function sleepBackoff(attempt: number, err: unknown): Promise<void> {
  if (err && typeof err === "object" && "retryAfterMs" in err) {
    const retry = (err as { retryAfterMs?: number }).retryAfterMs;
    if (typeof retry === "number" && retry >= 0) {
      await sleep(retry);
      return;
    }
  }
  const base = 250;
  const cap = 2000;
  const expo = Math.min(cap, base * 2 ** (attempt - 1));
  const jitter = expo * (0.5 + Math.random() * 0.5);
  await sleep(jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Connect envelope frames (server-streaming) ----------

interface Frame {
  flags: number;
  data: Uint8Array;
}

function encodeEnvelope(flags: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flags & 0xff;
  const view = new DataView(out.buffer as ArrayBuffer);
  view.setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

async function* readEnvelopes(stream: ReadableStream<Uint8Array>): AsyncIterable<Frame> {
  const reader = stream.getReader();
  let buf: Uint8Array = new Uint8Array(0);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value && value.length > 0) buf = concat(buf, value as Uint8Array);
      while (buf.length >= 5) {
        const flags = buf[0]!;
        const len = new DataView(buf.buffer as ArrayBuffer, buf.byteOffset + 1, 4).getUint32(0, false);
        if (buf.length < 5 + len) break;
        const data = buf.slice(5, 5 + len);
        buf = buf.slice(5 + len);
        yield { flags, data };
      }
      if (done) {
        if (buf.length > 0) {
          throw connectionError(new Error("stream ended with partial frame"));
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
