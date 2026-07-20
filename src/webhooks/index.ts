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
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  verifySignature,
  type VerifyOptions,
} from "./signature.js";
export { WEBHOOK_EVENT_TYPES } from "./types.js";
export type {
  EventBase,
  SpendLimitNotification,
  WebhookEvent,
  WebhookEventType,
} from "./types.js";
