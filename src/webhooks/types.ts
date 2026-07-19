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
  | (EventBase & { type: "video.source_scheduled_for_deletion"; data: Video })
  | (EventBase & { type: "app.created";     data: App })
  | (EventBase & { type: "app.updated";     data: App })
  | (EventBase & { type: string;            data: unknown });

/**
 * The 16 concrete webhook event types the API can emit. Mirrors the source of
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
  "video.source_scheduled_for_deletion",
  "app.created",
  "app.updated",
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

/** Look up a decoder by event type, or `undefined` if the type is unknown. */
export function decoderForType(type: string): DecoderEntry["decode"] | undefined {
  for (const entry of RESOURCE_DECODERS) {
    if (type.startsWith(entry.prefix)) return entry.decode;
  }
  return undefined;
}
