/**
 * Catalog-drift regression tests.
 *
 * The webhook event catalog is a hand-maintained mirror of
 * `domain.WebhookEventTypes()` in the API repo (api/internal/domain/webhook.go).
 * If the API ever adds, removes, or renames a concrete event type, this test
 * must fail loudly — silent drift here is what put `job.updated` in the SDK
 * after the API removed it.
 *
 * The expected catalog below is copied verbatim from the API source. Update
 * it in lockstep when the API changes — and only then.
 */

import { describe, expect, it } from "vitest";

import {
  WEBHOOK_EVENT_TYPES,
  type WebhookEvent,
} from "../../src/webhooks/types.js";

/**
 * The 13 concrete event types from `domain.WebhookEventTypes()`. The "*"
 * wildcard is intentionally NOT in this list: per the API contract it is only
 * valid as an `enabled_events` subscription value, never as the `type` of an
 * actually-emitted event.
 */
const EXPECTED_CATALOG = [
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
  "video.deleted",
  "app.created",
  "app.updated",
] as const;

describe("webhook event catalog", () => {
  it("WEBHOOK_EVENT_TYPES exactly matches the API's domain.WebhookEventTypes()", () => {
    expect([...WEBHOOK_EVENT_TYPES].sort()).toEqual([...EXPECTED_CATALOG].sort());
  });

  it("does not include the '*' wildcard (subscribe-only, never emitted)", () => {
    expect((WEBHOOK_EVENT_TYPES as readonly string[]).includes("*")).toBe(false);
  });

  it("does not include the removed 'job.updated' type", () => {
    // job.updated was dropped from the catalog when the platform moved to
    // terminal-only job events (Stripe parity). Regression guard so it does
    // not silently reappear.
    expect((WEBHOOK_EVENT_TYPES as readonly string[]).includes("job.updated")).toBe(false);
  });

  it("every catalog entry is a recognized WebhookEvent discriminant", () => {
    // TS-level check: every entry of WEBHOOK_EVENT_TYPES must satisfy the
    // discriminator side of the WebhookEvent union. The assignment compiles
    // only if every literal in the array is a valid `WebhookEvent["type"]`.
    const _typeCheck: ReadonlyArray<WebhookEvent["type"]> = WEBHOOK_EVENT_TYPES;
    expect(_typeCheck.length).toBe(EXPECTED_CATALOG.length);
  });
});
