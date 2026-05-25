/**
 * Public webhook surface. The {@link Webhooks} namespace mirrors the
 * Stripe SDK convention so customer code reads `client.webhooks.constructEvent(...)`
 * (or `Webhooks.constructEvent(...)` for consumers that don't instantiate
 * the full client).
 */

import {
  WebhookError,
  WebhookPayloadError,
  WebhookSignatureError,
  WebhookTimestampError,
} from "../errors.js";

import { constructEvent } from "./construct-event.js";

export const Webhooks = {
  constructEvent,
  WebhookError,
  WebhookSignatureError,
  WebhookTimestampError,
  WebhookPayloadError,
} as const;

export { constructEvent } from "./construct-event.js";
export {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  verifySignature,
  type VerifyOptions,
} from "./signature.js";
export type { EventBase, WebhookEvent } from "./types.js";
