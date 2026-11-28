/**
 * Which HTTP 429 answers the transport retries on its own.
 *
 * The API answers two different things with 429 (Connect `resource_exhausted`):
 * rate limits, which clear by themselves within seconds and are worth a
 * backoff-and-retry, and quota refusals (a spend cap, a full queue, the free
 * trial's daily allowance), which do not clear by waiting. Retrying a quota
 * refusal only resends a request the API has already refused, and for a
 * write it does so under the same idempotency key. The two are told apart by
 * the `error-code` discriminator the API stamps on every error (a response
 * header for unary calls), or the ErrorDetails code in the body.
 */

import { describe, expect, it, vi } from "vitest";

import { RateLimitError } from "../../src/errors.js";
import { GetIngestRuleResponse, IngestRule } from "../../src/gen/transcodely/v1/ingest_rule_pb.js";
import { IngestRules } from "../../src/resources/ingest-rules.js";
import { Transport } from "../../src/transport/transport.js";

const OK_BODY = new GetIngestRuleResponse({ rule: new IngestRule({ id: "ing_a1b2c3d4e5f6" }) }).toJsonString();

function client(fetchImpl: ReturnType<typeof vi.fn>): IngestRules {
  return new IngestRules(
    new Transport({
      apiKey: "tk_test",
      baseUrl: "https://example.invalid",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  );
}

/** A fetch that answers 429 once (carrying `code`, if any), then 200. */
function stub(code: string | undefined, where: "header" | "body" = "header"): ReturnType<typeof vi.fn> {
  let calls = 0;
  return vi.fn(async () => {
    calls++;
    if (calls === 1) {
      const headers: Record<string, string> = { "content-type": "application/json", "retry-after": "0" };
      const body: Record<string, unknown> = { code: "resource_exhausted", message: "refused" };
      if (code !== undefined && where === "header") headers["error-code"] = code;
      if (code !== undefined && where === "body") {
        body.details = [{ type: "transcodely.v1.ErrorDetails", value: "", debug: { code, message: "refused" } }];
      }
      return new Response(JSON.stringify(body), { status: 429, headers });
    }
    return new Response(OK_BODY, { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("quota refusals answered with 429", () => {
  it.each([
    "limit_exceeded",
    "queue_limit_exceeded",
    "free_trial_unavailable_today",
    // A quota code this SDK has never heard of is not retried either.
    "some_future_quota_exceeded",
  ])("does not retry %s: one request, and the refusal is surfaced", async (code) => {
    const fetchImpl = stub(code);
    const err = await client(fetchImpl)
      .get("ing_a1b2c3d4e5f6")
      .catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).httpStatus).toBe(429);
    expect((err as RateLimitError).code).toBe(code);
    expect((err as RateLimitError).type).toBe("resource_exhausted");
  });

  it("does not retry limit_exceeded carried in the body's ErrorDetails", async () => {
    const fetchImpl = stub("limit_exceeded", "body");
    const err = await client(fetchImpl)
      .get("ing_a1b2c3d4e5f6")
      .catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((err as RateLimitError).code).toBe("limit_exceeded");
  });
});

describe("rate limits answered with 429", () => {
  it.each([
    ["no error code", undefined],
    ["the generic resource_exhausted code", "resource_exhausted"],
    ["watch_rate_limited", "watch_rate_limited"],
    ["webhook_test_rate_limit", "webhook_test_rate_limit"],
    ["target_rate_limited", "target_rate_limited"],
    ["rate_limit_error", "rate_limit_error"],
  ])("still retries %s and returns the next answer", async (_label, code) => {
    const fetchImpl = stub(code);
    const rule = await client(fetchImpl).get("ing_a1b2c3d4e5f6");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(rule.id).toBe("ing_a1b2c3d4e5f6");
  });
});
