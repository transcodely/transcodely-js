import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  WebhookPayloadError,
  WebhookSignatureError,
  WebhookTimestampError,
} from "../../src/errors.js";
import { constructEvent } from "../../src/webhooks/construct-event.js";

import vectorsJson from "./fixtures/vectors.json" with { type: "json" };

interface Vector {
  name: string;
  /** Secret(s) the verifier accepts. */
  secret?: string;
  secrets?: string[];
  /** Optional override: secret the body was actually signed with. */
  signing_secret?: string;
  /** Optional override: body the signature was actually computed over (tamper case). */
  signing_body?: string;
  ts: number;
  body: string;
  tolerance: number;
  now: number;
  expect: {
    result: "ok" | "signature_error" | "timestamp_error" | "payload_error";
    event_type?: string;
    event_id?: string;
    data_id?: string;
    idempotency_key?: string;
    /** `null` for events emitted outside a request scope; omit the key entirely to skip this assertion. */
    request_id?: string | null;
  };
}

const vectors = (vectorsJson as { vectors: Vector[] }).vectors;

function sign(ts: number, body: string, secret: string): string {
  return createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

describe("conformance corpus", () => {
  for (const v of vectors) {
    it(v.name, () => {
      const signingSecret = v.signing_secret ?? v.secret ?? v.secrets![0];
      const signingBody = v.signing_body ?? v.body;
      const sigHeader = `t=${v.ts},v1=${sign(v.ts, signingBody, signingSecret)}`;
      const verifySecret: string | string[] = v.secrets ?? v.secret!;
      const callOpts = { now: () => v.now, tolerance: v.tolerance };

      const run = () => constructEvent(v.body, sigHeader, verifySecret, callOpts);

      switch (v.expect.result) {
        case "ok": {
          const event = run();
          if (v.expect.event_type) expect(event.type).toBe(v.expect.event_type);
          if (v.expect.event_id) expect(event.id).toBe(v.expect.event_id);
          if (v.expect.data_id) {
            expect(event.data).toBeDefined();
            expect((event.data as { id?: string }).id).toBe(v.expect.data_id);
          }
          if (v.expect.idempotency_key) {
            expect(event.request.idempotencyKey).toBe(v.expect.idempotency_key);
          }
          if (v.expect.request_id !== undefined) {
            expect(event.request.id).toBe(v.expect.request_id);
          }
          break;
        }
        case "signature_error":
          expect(run).toThrow(WebhookSignatureError);
          break;
        case "timestamp_error":
          expect(run).toThrow(WebhookTimestampError);
          break;
        case "payload_error":
          expect(run).toThrow(WebhookPayloadError);
          break;
      }
    });
  }
});
