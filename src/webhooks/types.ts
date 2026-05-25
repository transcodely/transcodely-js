/**
 * Public types for the webhook surface — the discriminated union customers
 * narrow on, and the resource decoder table shared between the verify
 * helper and the `client.events` resource bridge.
 */

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
  /** `true` for production-mode events. Reserved for a future test-mode concept. */
  livemode: boolean;
  /** Number of delivery attempts still pending across all subscribed endpoints. */
  pendingWebhooks: number;
  /** Originating API request, if known. */
  request: { id: string; idempotencyKey: string | null };
}

/**
 * Every event the platform may emit, discriminated by `type`. The final
 * `string` arm is intentional forward-compat: an older SDK receiving a
 * `type` the API has since added still parses; `data` is left as the raw
 * decoded JSON object and customers should handle it in a `default:` arm.
 */
export type WebhookEvent =
  | (EventBase & { type: "job.created";     data: Job })
  | (EventBase & { type: "job.updated";     data: Job })
  | (EventBase & { type: "job.succeeded";   data: Job })
  | (EventBase & { type: "job.failed";      data: Job })
  | (EventBase & { type: "job.canceled";    data: Job })
  | (EventBase & { type: "job.progress";    data: Job })
  | (EventBase & { type: "output.created";  data: JobOutput })
  | (EventBase & { type: "output.ready";    data: JobOutput })
  | (EventBase & { type: "output.failed";   data: JobOutput })
  | (EventBase & { type: "output.progress"; data: JobOutput })
  | (EventBase & { type: "video.uploaded";  data: Video })
  | (EventBase & { type: "video.deleted";   data: Video })
  | (EventBase & { type: "app.created";     data: App })
  | (EventBase & { type: "app.updated";     data: App })
  | (EventBase & { type: string;            data: unknown });

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
 * The `output.` entry must precede no other entry — prefixes are disjoint
 * today, so order is informational, but keep `output.` first to make the
 * intent explicit.
 */
export const RESOURCE_DECODERS: readonly DecoderEntry[] = [
  { prefix: "output.", decode: (json) => JobOutput.fromJson(json as never, { ignoreUnknownFields: true }) },
  { prefix: "job.",    decode: (json) => Job.fromJson(json as never, { ignoreUnknownFields: true }) },
  { prefix: "video.",  decode: (json) => Video.fromJson(json as never, { ignoreUnknownFields: true }) },
  { prefix: "app.",    decode: (json) => App.fromJson(json as never, { ignoreUnknownFields: true }) },
];

/** Look up a decoder by event type, or `undefined` if the type is unknown. */
export function decoderForType(type: string): DecoderEntry["decode"] | undefined {
  for (const entry of RESOURCE_DECODERS) {
    if (type.startsWith(entry.prefix)) return entry.decode;
  }
  return undefined;
}
