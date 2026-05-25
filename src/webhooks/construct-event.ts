import { WebhookPayloadError } from "../errors.js";

import { decoderForType, type WebhookEvent } from "./types.js";
import { verifySignature, type VerifyOptions } from "./signature.js";

/**
 * Verify a signed webhook delivery, validate the envelope, and decode the
 * inner resource into a typed {@link WebhookEvent}.
 *
 * Throws {@link WebhookSignatureError} on a bad signature,
 * {@link WebhookTimestampError} when the timestamp falls outside the
 * tolerance window, and {@link WebhookPayloadError} when the body is
 * unparseable or the envelope shape is wrong.
 */
export function constructEvent(
  rawBody: string | Uint8Array | Buffer,
  sigHeader: string,
  secret: string | string[],
  opts?: VerifyOptions,
): WebhookEvent {
  const bytes = toBytes(rawBody);

  verifySignature(bytes, sigHeader, secret, opts);

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch (cause) {
    throw new WebhookPayloadError("Webhook body is not valid JSON", { cause });
  }

  return buildEvent(parsed);
}

function toBytes(body: string | Uint8Array | Buffer): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (Buffer.isBuffer(body)) return body;
  return body;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new WebhookPayloadError(`Webhook envelope is missing required string field \`${key}\``);
  }
  return v;
}

function requireBoolean(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") {
    throw new WebhookPayloadError(`Webhook envelope field \`${key}\` must be a boolean`);
  }
  return v;
}

function requireNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new WebhookPayloadError(`Webhook envelope field \`${key}\` must be a number`);
  }
  return v;
}

function buildEvent(parsed: unknown): WebhookEvent {
  if (!isPlainObject(parsed)) {
    throw new WebhookPayloadError("Webhook body must be a JSON object");
  }

  const id = requireString(parsed, "id");
  if (parsed["object"] !== "event") {
    throw new WebhookPayloadError(`Webhook envelope \`object\` must be "event"`);
  }
  const apiVersion = requireString(parsed, "api_version");
  const created = requireString(parsed, "created");
  const type = requireString(parsed, "type");
  const livemode = requireBoolean(parsed, "livemode");
  const pendingWebhooks = requireNumber(parsed, "pending_webhooks");

  const dataRaw = parsed["data"];
  if (!isPlainObject(dataRaw)) {
    throw new WebhookPayloadError("Webhook envelope field `data` must be a JSON object");
  }

  const requestRaw = parsed["request"];
  if (!isPlainObject(requestRaw)) {
    throw new WebhookPayloadError("Webhook envelope field `request` must be a JSON object");
  }
  const requestId = requireString(requestRaw, "id");
  const idempotencyKeyRaw = requestRaw["idempotency_key"];
  if (idempotencyKeyRaw !== null && typeof idempotencyKeyRaw !== "string") {
    throw new WebhookPayloadError(
      "Webhook envelope field `request.idempotency_key` must be a string or null",
    );
  }

  const decode = decoderForType(type);
  const data: unknown = decode ? decode(dataRaw) : dataRaw;

  // Discriminated union narrowing happens on the consumer side via `type`;
  // we assert here because we've validated every field individually above.
  return {
    id,
    object: "event",
    apiVersion,
    created,
    type,
    data,
    livemode,
    pendingWebhooks,
    request: { id: requestId, idempotencyKey: idempotencyKeyRaw },
  } as WebhookEvent;
}
