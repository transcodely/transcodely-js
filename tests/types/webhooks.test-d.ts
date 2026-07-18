/**
 * Type-level regression tests for the WebhookEvent discriminated union
 * (transcodely-js#34: the union failed to narrow because a `type: string`
 * catch-all arm sat in the same union as the literal arms).
 *
 * These assertions are enforced by `pnpm typecheck` (which points at
 * tsconfig.typecheck.json and includes this directory). They are NOT executed
 * by vitest — the `.test-d.ts` suffix falls outside vitest's default include
 * glob — so a regression surfaces as a compile error, never a runtime one.
 * Keep every assertion type-only.
 */
import { App } from "../../src/gen/transcodely/v1/app_pb.js";
import { Job, JobOutput } from "../../src/gen/transcodely/v1/job_pb.js";
import { Video } from "../../src/gen/transcodely/v1/video_pb.js";
import {
  isEventType,
  isKnownEvent,
  type KnownWebhookEvent,
  type UnknownWebhookEvent,
  type WebhookEvent,
  type WebhookEventType,
} from "../../src/webhooks/types.js";

/** Compile error unless `A` and `B` are the *exact* same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<_Pass extends true>(): void {}

declare const event: WebhookEvent;

// (1) After `isKnownEvent`, each `switch` case narrows `event.data` to its
//     exact decoded resource type — the behaviour #34 asked for.
if (isKnownEvent(event)) {
  switch (event.type) {
    case "job.created":
    case "job.succeeded":
    case "job.failed":
    case "job.canceled":
    case "job.progress":
      expectType<Equal<typeof event.data, Job>>();
      break;
    case "output.created":
    case "output.ready":
    case "output.failed":
    case "output.progress":
      expectType<Equal<typeof event.data, JobOutput>>();
      break;
    case "video.uploaded":
    case "video.ready":
    case "video.failed":
    case "video.deleted":
      expectType<Equal<typeof event.data, Video>>();
      break;
    case "app.created":
    case "app.updated":
      expectType<Equal<typeof event.data, App>>();
      break;
    default: {
      // Exhaustiveness: with every KnownWebhookEvent arm handled, the residue
      // is `never`. Adding a known type without a `case` breaks this line.
      const _exhaustive: never = event;
      void _exhaustive;
    }
  }
} else {
  // (2) The forward-compat arm keeps `data` as `unknown` and `type` as string.
  const _unknownArm: UnknownWebhookEvent = event;
  void _unknownArm;
  expectType<Equal<typeof event.data, unknown>>();
  expectType<Equal<typeof event.type, string>>();
}

// `isEventType` narrows straight to a single arm's resource type.
if (isEventType(event, "output.ready")) {
  expectType<Equal<typeof event.data, JobOutput>>();
}

// (3) Forward-compat: an event `type` this SDK release does not know is still
//     a legal value to receive and compare — no compile error.
declare const future: WebhookEvent;
if (future.type === "some.future.event.v99") {
  expectType<Equal<typeof future.data, unknown>>();
}

// `isEventType` rejects a non-catalog literal at the call site.
// @ts-expect-error - "job.exploded" is not a WebhookEventType
isEventType(event, "job.exploded");

// Back-compat: every known arm is still assignable to WebhookEvent, and the
// whole union's discriminant is still `string`, so code written against the
// pre-fix single-union shape keeps compiling.
declare const known: KnownWebhookEvent;
const _widen: WebhookEvent = known;
void _widen;
expectType<Equal<WebhookEvent["type"], string>>();

// Catalog alignment: the KnownWebhookEvent arms must match WEBHOOK_EVENT_TYPES
// exactly. Drift between the union and the exported catalog fails here.
expectType<Equal<KnownWebhookEvent["type"], WebhookEventType>>();
