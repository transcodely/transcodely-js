/**
 * Public types for the webhook surface — the discriminated union customers
 * narrow on, and the resource decoder table shared between the verify
 * helper and the `client.events` resource bridge.
 */

import type { JsonValue } from "@bufbuild/protobuf";

import { fromJson } from "../codec/json.js";
import { App } from "../gen/transcodely/v1/app_pb.js";
import { Job, JobOutput } from "../gen/transcodely/v1/job_pb.js";
import { Video } from "../gen/transcodely/v1/video_pb.js";

/** Fields common to every webhook event, regardless of `type`. */
export interface EventBase {
  /** `evt_*` ID. */
  id: string;
  /** Discriminator. Always `"event"`. */
  object: "event";
  /** API version at emit time (e.g. `"2026-05-23"`). Frozen for the event's lifetime. */
  apiVersion: string;
  /** RFC 3339 UTC timestamp of when the event was created. */
  created: string;
  /** Number of delivery attempts still pending across all subscribed endpoints. */
  pendingWebhooks: number;
  /**
   * Originating API request, if known. `id` is `null` for events emitted
   * outside a request scope (e.g. worker-callback events like
   * `job.succeeded`); `idempotencyKey` is `null` when the caller didn't
   * supply one on the originating request.
   */
  request: { id: string | null; idempotencyKey: string | null };
}

/**
 * Every event the platform may emit, discriminated by `type`. The final
 * `string` arm is intentional forward-compat: an older SDK receiving a
 * `type` the API has since added still parses; `data` is left as the raw
 * decoded JSON object and customers should handle it in a `default:` arm.
 */
export type WebhookEvent =
  | (EventBase & { type: "job.created";     data: Job })
  | (EventBase & { type: "job.succeeded";   data: Job })
  | (EventBase & { type: "job.failed";      data: Job })
  | (EventBase & { type: "job.canceled";    data: Job })
  | (EventBase & { type: "job.progress";    data: Job })
  | (EventBase & { type: "output.created";  data: JobOutput })
  | (EventBase & { type: "output.ready";    data: JobOutput })
  | (EventBase & { type: "output.failed";   data: JobOutput })
  | (EventBase & { type: "output.progress"; data: JobOutput })
  | (EventBase & { type: "video.uploaded";  data: Video })
  | (EventBase & { type: "video.ready";     data: Video })
  | (EventBase & { type: "video.failed";    data: Video })
  | (EventBase & { type: "video.deleted";   data: Video })
  | (EventBase & { type: "app.created";     data: App })
  | (EventBase & { type: "app.updated";     data: App })
  | (EventBase & { type: "app.spend_limit_warning";  data: SpendLimitNotification })
  | (EventBase & { type: "app.spend_limit_exceeded"; data: SpendLimitNotification })
  | (EventBase & { type: string;            data: unknown });

/**
 * Payload of the `app.spend_limit_warning` and `app.spend_limit_exceeded`
 * events. Unlike the resource-carrying events, these carry a small notification
 * object (snake_case, as delivered on the wire) rather than a resource snapshot,
 * so `data` is the raw parsed JSON — it is not run through the resource codec.
 */
export interface SpendLimitNotification {
  /** The app the spend limit belongs to (`app_*`). */
  app_id: string;
  /** Inclusive start of the billing period, an RFC 3339 full-date in UTC (e.g. `"2026-01-01"`). */
  period_start: string;
  /** Exclusive end of the billing period, an RFC 3339 full-date in UTC (e.g. `"2026-02-01"`). */
  period_end: string;
  /** The app's monthly spend limit in EUR. */
  limit_eur: number;
  /** Recorded spend for the period in EUR at the time the event fired. */
  spent_eur: number;
  /** Threshold crossed: `80` for the warning event, `100` for the breach event. */
  threshold_pct: 80 | 100;
  /** Currency of the amounts in this payload. Always `"EUR"`. */
  currency: "EUR";
}

/**
 * The 17 concrete webhook event types the API can emit. Mirrors the source of
 * truth in `domain.WebhookEventTypes()` (api/internal/domain/webhook.go). The
 * `"*"` wildcard is a subscription-only value and is intentionally absent.
 *
 * Exported so consumers can validate `enabledEvents` lists and so the
 * catalog-drift regression test can compare this set against the discriminated
 * union literals above.
 */
export const WEBHOOK_EVENT_TYPES = [
  "job.created",
  "job.succeeded",
  "job.failed",
  "job.canceled",
  "job.progress",
  "output.created",
  "output.ready",
  "output.failed",
  "output.progress",
  "video.uploaded",
  "video.ready",
  "video.failed",
  "video.deleted",
  "app.created",
  "app.updated",
  "app.spend_limit_warning",
  "app.spend_limit_exceeded",
] as const;

/** A concrete event type the API can emit (excludes the `"*"` wildcard). */
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** A resource decoder for a given event-type prefix. */
interface DecoderEntry {
  prefix: string;
  decode: (json: unknown) => Job | JobOutput | Video | App;
}

/**
 * Event-type prefix → MessageType decoder. Shared by `constructEvent`
 * (verify path, JSON arrives pre-parsed) and the `events` resource bridge
 * (API-Event path, JSON arrives as a string field on the proto Event).
 *
 * Each decoder goes through the codec's `fromJson`, NOT the raw
 * `MessageType.fromJson`. This is load-bearing: the server emits the inner
 * resource with simplified lowercase enum values (e.g. "completed"), and the
 * codec's `fromJson` runs the enum-expansion transform first. The raw
 * `MessageType.fromJson` with `ignoreUnknownFields` would silently zero every
 * enum field to UNSPECIFIED instead — see the enum regression tests.
 *
 * The `output.` entry must precede no other entry — prefixes are disjoint
 * today, so order is informational, but keep `output.` first to make the
 * intent explicit.
 */
export const RESOURCE_DECODERS: readonly DecoderEntry[] = [
  { prefix: "output.", decode: (json) => fromJson(json as JsonValue, JobOutput) },
  { prefix: "job.",    decode: (json) => fromJson(json as JsonValue, Job) },
  { prefix: "video.",  decode: (json) => fromJson(json as JsonValue, Video) },
  { prefix: "app.",    decode: (json) => fromJson(json as JsonValue, App) },
];

/**
 * Event types that share a resource prefix but carry a notification payload
 * rather than a resource snapshot. Their `data` is left as the raw parsed JSON.
 */
const NOTIFICATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "app.spend_limit_warning",
  "app.spend_limit_exceeded",
]);

/** Look up a decoder by event type, or `undefined` if the type is unknown. */
export function decoderForType(type: string): DecoderEntry["decode"] | undefined {
  // Spend-limit events share the "app." prefix but are notification payloads,
  // not App snapshots — leave their `data` as the raw JSON object.
  if (NOTIFICATION_EVENT_TYPES.has(type)) return undefined;
  for (const entry of RESOURCE_DECODERS) {
    if (type.startsWith(entry.prefix)) return entry.decode;
  }
  return undefined;
}
