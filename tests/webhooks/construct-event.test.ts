import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  WebhookPayloadError,
  WebhookSignatureError,
  WebhookTimestampError,
} from "../../src/errors.js";
import { App, AppStatus } from "../../src/gen/transcodely/v1/app_pb.js";
import { Job, JobOutput, JobStatus, OutputStatus } from "../../src/gen/transcodely/v1/job_pb.js";
import { Video } from "../../src/gen/transcodely/v1/video_pb.js";
import { constructEvent } from "../../src/webhooks/construct-event.js";

const SECRET = "whsec_test_12345678901234567890abcdef";
const TS = 1_716_480_293;
const NOW = () => TS;

interface EnvelopeInput {
  id?: string;
  object?: string;
  apiVersion?: string;
  created?: string;
  type?: string;
  data?: unknown;
  livemode?: boolean;
  pendingWebhooks?: number;
  request?: unknown;
}

function envelope(overrides: EnvelopeInput = {}): string {
  const base = {
    id: "evt_abc123",
    object: "event",
    api_version: "2026-05-23",
    created: "2026-05-24T10:55:08Z",
    type: "job.succeeded",
    data: { id: "job_abc", object: "job", status: "completed", input_url: "https://x/in.mp4" },
    livemode: true,
    pending_webhooks: 0,
    request: { id: "req_xyz", idempotency_key: null as string | null },
  };
  if (overrides.id !== undefined) base.id = overrides.id;
  if (overrides.object !== undefined) base.object = overrides.object;
  if (overrides.apiVersion !== undefined) base.api_version = overrides.apiVersion;
  if (overrides.created !== undefined) base.created = overrides.created;
  if (overrides.type !== undefined) base.type = overrides.type;
  if (overrides.data !== undefined) (base as Record<string, unknown>).data = overrides.data;
  if (overrides.livemode !== undefined) base.livemode = overrides.livemode;
  if (overrides.pendingWebhooks !== undefined) base.pending_webhooks = overrides.pendingWebhooks;
  if (overrides.request !== undefined) (base as Record<string, unknown>).request = overrides.request;
  return JSON.stringify(base);
}

function header(body: string, ts = TS, secret = SECRET): string {
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}

describe("constructEvent — happy paths", () => {
  it("decodes a job.succeeded event with Job data", () => {
    const body = envelope({ type: "job.succeeded" });
    const event = constructEvent(body, header(body), SECRET, { now: NOW });
    expect(event.type).toBe("job.succeeded");
    expect(event.id).toBe("evt_abc123");
    expect(event.object).toBe("event");
    expect(event.apiVersion).toBe("2026-05-23");
    expect(event.created).toBe("2026-05-24T10:55:08Z");
    expect(event.livemode).toBe(true);
    expect(event.pendingWebhooks).toBe(0);
    expect(event.request).toEqual({ id: "req_xyz", idempotencyKey: null });
    expect(event.data).toBeInstanceOf(Job);
    expect((event.data as Job).id).toBe("job_abc");
    expect((event.data as Job).inputUrl).toBe("https://x/in.mp4");
    // The server sends simplified lowercase enums ("completed"); the SDK must
    // expand them back to the proto enum before fromJson, or the field is
    // silently zeroed to UNSPECIFIED. This is the C1 regression guard.
    expect((event.data as Job).status).toBe(JobStatus.COMPLETED);
  });

  it("decodes an output.ready event with JobOutput data", () => {
    const body = envelope({
      type: "output.ready",
      data: { id: "jot_abc", status: "completed", output_url: "https://cdn/out.m3u8", progress: 100 },
    });
    const event = constructEvent(body, header(body), SECRET, { now: NOW });
    expect(event.type).toBe("output.ready");
    expect(event.data).toBeInstanceOf(JobOutput);
    expect((event.data as JobOutput).id).toBe("jot_abc");
    expect((event.data as JobOutput).outputUrl).toBe("https://cdn/out.m3u8");
    expect((event.data as JobOutput).status).toBe(OutputStatus.COMPLETED);
  });

  it("decodes a video.uploaded event with Video data", () => {
    const body = envelope({
      type: "video.uploaded",
      data: { id: "vid_abc", object: "video", status: "ready" },
    });
    const event = constructEvent(body, header(body), SECRET, { now: NOW });
    expect(event.type).toBe("video.uploaded");
    expect(event.data).toBeInstanceOf(Video);
    expect((event.data as Video).id).toBe("vid_abc");
    // Video.status/visibility are plain string fields on the proto (not enums),
    // so they pass through verbatim and are unaffected by enum expansion.
    expect((event.data as Video).status).toBe("ready");
  });

  it("decodes an app.created event with App data", () => {
    const body = envelope({
      type: "app.created",
      data: { id: "app_abc", object: "app", name: "My App", status: "active" },
    });
    const event = constructEvent(body, header(body), SECRET, { now: NOW });
    expect(event.type).toBe("app.created");
    expect(event.data).toBeInstanceOf(App);
    expect((event.data as App).id).toBe("app_abc");
    expect((event.data as App).name).toBe("My App");
    expect((event.data as App).status).toBe(AppStatus.ACTIVE);
  });

  it("preserves a non-null request.idempotencyKey", () => {
    const body = envelope({ request: { id: "req_xyz", idempotency_key: "user_supplied_key" } });
    const event = constructEvent(body, header(body), SECRET, { now: NOW });
    expect(event.request.idempotencyKey).toBe("user_supplied_key");
  });

  it("accepts a null request.id (async-pipeline events have no originating request)", () => {
    // `job.succeeded`/`.failed`/`.progress` are emitted from worker callbacks
    // with no Connect-RPC request scope; the API sends `request.id: null`.
    // Regression guard: the old envelope validator rejected null and made
    // every async job event un-decodable.
    const body = envelope({ request: { id: null, idempotency_key: null } });
    const event = constructEvent(body, header(body), SECRET, { now: NOW });
    expect(event.type).toBe("job.succeeded");
    expect(event.request.id).toBeNull();
    expect(event.request.idempotencyKey).toBeNull();
  });

  it("accepts a Buffer body and a Uint8Array body", () => {
    const body = envelope();
    const buf = Buffer.from(body);
    const u8 = new TextEncoder().encode(body);
    expect(() => constructEvent(buf, header(body), SECRET, { now: NOW })).not.toThrow();
    expect(() => constructEvent(u8, header(body), SECRET, { now: NOW })).not.toThrow();
  });

  it("returns an unknown event type with data as a plain object (forward-compat)", () => {
    const body = envelope({
      type: "job.scheduled",
      data: { id: "job_future", object: "job_scheduled" },
    });
    const event = constructEvent(body, header(body), SECRET, { now: NOW });
    expect(event.type).toBe("job.scheduled");
    // job.scheduled prefix-matches `job.` so it does decode to Job; pick a
    // type with no prefix match for the genuinely-unknown case
    expect(event.data).toBeInstanceOf(Job);
  });

  it("leaves data as plain object when no prefix matches", () => {
    const body = envelope({
      type: "future.thing",
      data: { id: "ftr_abc", object: "future" },
    });
    const event = constructEvent(body, header(body), SECRET, { now: NOW });
    expect(event.type).toBe("future.thing");
    expect(event.data).toEqual({ id: "ftr_abc", object: "future" });
  });
});

describe("constructEvent — error paths", () => {
  it("WebhookSignatureError when the body is tampered", () => {
    const body = envelope();
    const sig = header(body);
    const tampered = body.replace("evt_abc123", "evt_other000");
    expect(() => constructEvent(tampered, sig, SECRET, { now: NOW })).toThrow(
      WebhookSignatureError,
    );
  });

  it("WebhookSignatureError on wrong secret", () => {
    const body = envelope();
    expect(() => constructEvent(body, header(body), "whsec_other", { now: NOW })).toThrow(
      WebhookSignatureError,
    );
  });

  it("WebhookTimestampError on expired timestamp", () => {
    const body = envelope();
    const expired = TS - 600;
    expect(() => constructEvent(body, header(body, expired), SECRET, { now: NOW })).toThrow(
      WebhookTimestampError,
    );
  });

  it("WebhookPayloadError on malformed JSON", () => {
    const body = "{not valid json";
    expect(() => constructEvent(body, header(body), SECRET, { now: NOW })).toThrow(
      WebhookPayloadError,
    );
  });

  it("WebhookPayloadError when object !== 'event'", () => {
    const body = envelope({ object: "something_else" });
    expect(() => constructEvent(body, header(body), SECRET, { now: NOW })).toThrow(
      WebhookPayloadError,
    );
  });

  it("WebhookPayloadError when data is a string instead of object", () => {
    const body = JSON.stringify({
      id: "evt_x",
      object: "event",
      api_version: "2026-05-23",
      created: "2026-05-24T10:55:08Z",
      type: "job.succeeded",
      data: "not an object",
      livemode: true,
      pending_webhooks: 0,
      request: { id: "req_x", idempotency_key: null },
    });
    expect(() => constructEvent(body, header(body), SECRET, { now: NOW })).toThrow(
      WebhookPayloadError,
    );
  });

  it("WebhookPayloadError when required envelope field is missing", () => {
    const body = JSON.stringify({
      // missing `id`
      object: "event",
      api_version: "2026-05-23",
      created: "2026-05-24T10:55:08Z",
      type: "job.succeeded",
      data: {},
      livemode: true,
      pending_webhooks: 0,
      request: { id: "req_x", idempotency_key: null },
    });
    expect(() => constructEvent(body, header(body), SECRET, { now: NOW })).toThrow(
      WebhookPayloadError,
    );
  });

  it("WebhookPayloadError when request.idempotency_key is the wrong type", () => {
    const body = envelope({ request: { id: "req_x", idempotency_key: 42 } });
    expect(() => constructEvent(body, header(body), SECRET, { now: NOW })).toThrow(
      WebhookPayloadError,
    );
  });

  it("WebhookPayloadError when request.id is the wrong type (not string or null)", () => {
    const body = envelope({ request: { id: 42, idempotency_key: null } });
    expect(() => constructEvent(body, header(body), SECRET, { now: NOW })).toThrow(
      WebhookPayloadError,
    );
  });

  it("WebhookPayloadError when body is a JSON array, not an object", () => {
    const body = "[]";
    expect(() => constructEvent(body, header(body), SECRET, { now: NOW })).toThrow(
      WebhookPayloadError,
    );
  });
});
