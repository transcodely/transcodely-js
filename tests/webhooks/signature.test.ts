import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { WebhookSignatureError, WebhookTimestampError } from "../../src/errors.js";
import { verifySignature } from "../../src/webhooks/signature.js";

const SECRET = "whsec_test_12345678901234567890abcdef";
const SECRET_B = "whsec_test_xxxxxxxxxxxxxxxxxxxxabcd";

function sign(timestamp: number, body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("verifySignature", () => {
  const ts = 1_716_480_293;
  const body = `{"id":"evt_x","object":"event"}`;
  const now = () => ts;

  it("accepts a well-formed single-signature header", () => {
    const sig = sign(ts, body);
    expect(() =>
      verifySignature(bytes(body), `t=${ts},v1=${sig}`, SECRET, { now }),
    ).not.toThrow();
  });

  it("accepts the second v1 entry when the first does not match (rotation in flight)", () => {
    const wrong = "0".repeat(64);
    const right = sign(ts, body);
    expect(() =>
      verifySignature(bytes(body), `t=${ts},v1=${wrong},v1=${right}`, SECRET, { now }),
    ).not.toThrow();
  });

  it("accepts an array of secrets and matches against any (multi-secret rotation)", () => {
    const sig = sign(ts, body, SECRET_B);
    expect(() =>
      verifySignature(bytes(body), `t=${ts},v1=${sig}`, [SECRET, SECRET_B], { now }),
    ).not.toThrow();
  });

  it("rejects a tampered body with WebhookSignatureError", () => {
    const sig = sign(ts, body);
    const tampered = bytes(body.replace("evt_x", "evt_y"));
    expect(() =>
      verifySignature(tampered, `t=${ts},v1=${sig}`, SECRET, { now }),
    ).toThrow(WebhookSignatureError);
  });

  it("rejects a body signed with the wrong secret", () => {
    const sig = sign(ts, body, SECRET_B);
    expect(() =>
      verifySignature(bytes(body), `t=${ts},v1=${sig}`, SECRET, { now }),
    ).toThrow(WebhookSignatureError);
  });

  it("accepts a timestamp exactly at the tolerance edge (299 s)", () => {
    const old = ts - 299;
    const sig = sign(old, body);
    expect(() =>
      verifySignature(bytes(body), `t=${old},v1=${sig}`, SECRET, { now }),
    ).not.toThrow();
  });

  it("rejects a timestamp 301 s out as WebhookTimestampError", () => {
    const old = ts - 301;
    const sig = sign(old, body);
    expect(() =>
      verifySignature(bytes(body), `t=${old},v1=${sig}`, SECRET, { now }),
    ).toThrow(WebhookTimestampError);
  });

  it("honors a custom tolerance window", () => {
    const old = ts - 60;
    const sig = sign(old, body);
    // tolerance=30 should reject the 60s-old timestamp
    expect(() =>
      verifySignature(bytes(body), `t=${old},v1=${sig}`, SECRET, { now, tolerance: 30 }),
    ).toThrow(WebhookTimestampError);
  });

  it("throws WebhookSignatureError for header missing t=", () => {
    expect(() => verifySignature(bytes(body), `v1=${"0".repeat(64)}`, SECRET, { now })).toThrow(
      WebhookSignatureError,
    );
  });

  it("throws WebhookSignatureError for header with no v1 entries", () => {
    expect(() => verifySignature(bytes(body), `t=${ts},foo=bar`, SECRET, { now })).toThrow(
      WebhookSignatureError,
    );
  });

  it("ignores unknown scheme keys (forward-compat for v2= etc.)", () => {
    const sig = sign(ts, body);
    expect(() =>
      verifySignature(bytes(body), `t=${ts},v0=ignored,v1=${sig},v2=ignored`, SECRET, { now }),
    ).not.toThrow();
  });

  it("rejects mismatched signature lengths without crashing", () => {
    // half-length hex string — would crash if we ran timingSafeEqual on
    // unequal buffers, but safeHexEqual short-circuits
    const halfSig = "abcd".repeat(8);
    expect(() =>
      verifySignature(bytes(body), `t=${ts},v1=${halfSig}`, SECRET, { now }),
    ).toThrow(WebhookSignatureError);
  });
});
