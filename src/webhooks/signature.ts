import { createHmac, timingSafeEqual } from "node:crypto";

import { WebhookSignatureError, WebhookTimestampError } from "../errors.js";

/** Default signature tolerance window in seconds (Stripe parity). */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** HTTP header name carrying the signature (lower-cased for `Headers#get`). */
export const SIGNATURE_HEADER = "transcodely-signature";

export interface VerifyOptions {
  /** Tolerance in seconds. Defaults to {@link DEFAULT_TOLERANCE_SECONDS}. */
  tolerance?: number;
  /** Clock override (unix seconds). Defaults to `Date.now() / 1000`. Useful for tests. */
  now?: () => number;
}

interface ParsedHeader {
  timestamp: number;
  signatures: string[];
}

/**
 * Parse the `Transcodely-Signature` header. The header is a comma-separated
 * list of `key=value` pairs. `t` is the unix timestamp (seconds); each
 * `v1` entry is a hex-encoded HMAC-SHA-256. Unknown keys are ignored so
 * future scheme versions don't break older receivers.
 */
function parseHeader(header: string): ParsedHeader {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const n = Number(value);
      if (Number.isFinite(n) && Number.isInteger(n)) timestamp = n;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (timestamp === undefined) {
    throw new WebhookSignatureError("Signature header is missing the timestamp (t=) component");
  }
  if (signatures.length === 0) {
    throw new WebhookSignatureError("Signature header has no v1 entries");
  }
  return { timestamp, signatures };
}

/** Constant-time compare of two hex strings. Returns `false` on length mismatch (no leak). */
function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a webhook signature. Throws on failure; returns nothing on success.
 *
 * Multiple secrets are accepted so a customer rotating their signing
 * secret can pass `[previous, current]` during the overlap window without
 * dropping legitimate deliveries signed under either key.
 */
export function verifySignature(
  rawBody: Uint8Array,
  sigHeader: string,
  secret: string | string[],
  opts: VerifyOptions = {},
): void {
  const { timestamp, signatures } = parseHeader(sigHeader);

  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE_SECONDS;
  const now = (opts.now ?? (() => Math.floor(Date.now() / 1000)))();
  if (Math.abs(now - timestamp) > tolerance) {
    throw new WebhookTimestampError(
      `Signature timestamp is outside the tolerance window (${tolerance}s)`,
    );
  }

  const secrets = Array.isArray(secret) ? secret : [secret];
  const payload = Buffer.concat([
    Buffer.from(`${timestamp}.`),
    Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody),
  ]);

  for (const s of secrets) {
    const expected = createHmac("sha256", s).update(payload).digest("hex");
    for (const candidate of signatures) {
      if (safeHexEqual(expected, candidate)) return;
    }
  }

  throw new WebhookSignatureError("No signatures matched the expected value");
}
