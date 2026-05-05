import { describe, expect, it } from "vitest";

import {
  APIError,
  AuthenticationError,
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  PermissionError,
  PreconditionError,
  RateLimitError,
} from "../../src/errors.js";
import { connectionError, mapHttpError } from "../../src/transport/error-mapping.js";

const noHeaders = new Headers();

function withReqId(id: string): Headers {
  const h = new Headers();
  h.set("x-request-id", id);
  return h;
}

describe("mapHttpError — status → typed error class", () => {
  it("maps 401 to AuthenticationError", () => {
    const err = mapHttpError({ status: 401, body: {}, headers: noHeaders });
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.httpStatus).toBe(401);
  });

  it("maps 403 to PermissionError", () => {
    expect(mapHttpError({ status: 403, body: {}, headers: noHeaders })).toBeInstanceOf(
      PermissionError,
    );
  });

  it("maps 404 to NotFoundError", () => {
    expect(mapHttpError({ status: 404, body: {}, headers: noHeaders })).toBeInstanceOf(
      NotFoundError,
    );
  });

  it("maps 409 to ConflictError", () => {
    expect(mapHttpError({ status: 409, body: {}, headers: noHeaders })).toBeInstanceOf(
      ConflictError,
    );
  });

  it("maps 412 to PreconditionError", () => {
    expect(mapHttpError({ status: 412, body: {}, headers: noHeaders })).toBeInstanceOf(
      PreconditionError,
    );
  });

  it("maps 422 to InvalidRequestError", () => {
    expect(mapHttpError({ status: 422, body: {}, headers: noHeaders })).toBeInstanceOf(
      InvalidRequestError,
    );
  });

  it("maps generic 4xx to InvalidRequestError", () => {
    expect(mapHttpError({ status: 400, body: {}, headers: noHeaders })).toBeInstanceOf(
      InvalidRequestError,
    );
  });

  it("maps every 5xx to APIError", () => {
    expect(mapHttpError({ status: 500, body: {}, headers: noHeaders })).toBeInstanceOf(APIError);
    expect(mapHttpError({ status: 503, body: {}, headers: noHeaders })).toBeInstanceOf(APIError);
  });
});

describe("mapHttpError — RateLimitError + Retry-After", () => {
  it("maps 429 to RateLimitError", () => {
    const h = new Headers();
    h.set("retry-after", "5");
    const err = mapHttpError({ status: 429, body: {}, headers: h });
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(5000);
  });

  it("leaves retryAfterMs undefined when header missing", () => {
    const err = mapHttpError({ status: 429, body: {}, headers: noHeaders });
    expect((err as RateLimitError).retryAfterMs).toBeUndefined();
  });

  it("clamps a negative Retry-After to zero", () => {
    const h = new Headers();
    h.set("retry-after", "-3");
    const err = mapHttpError({ status: 429, body: {}, headers: h });
    expect((err as RateLimitError).retryAfterMs).toBe(0);
  });
});

describe("mapHttpError — payload extraction", () => {
  const body = {
    code: "invalid_argument",
    message: "validation failed",
    details: [
      {
        type: "transcodely.v1.ErrorDetails",
        debug: {
          code: "JOB_INPUT_URL_INVALID",
          field_violations: [{ field: "input_url", description: "must be a valid URL" }],
        },
      },
    ],
  };

  it("propagates server code, message, type, and field violations", () => {
    const err = mapHttpError({ status: 422, body, headers: noHeaders });
    expect(err.message).toBe("validation failed");
    expect(err.code).toBe("JOB_INPUT_URL_INVALID");
    expect(err.type).toBe("invalid_argument");
    expect(err.errors).toHaveLength(1);
    expect(err.errors[0]).toEqual({ field: "input_url", description: "must be a valid URL" });
  });

  it("accepts camelCase fieldViolations as a fallback", () => {
    const camel = {
      message: "v",
      details: [
        {
          debug: {
            fieldViolations: [{ field: "x", description: "y" }],
          },
        },
      ],
    };
    const err = mapHttpError({ status: 422, body: camel, headers: noHeaders });
    expect(err.errors[0]?.field).toBe("x");
  });

  it("captures requestId from headers", () => {
    const err = mapHttpError({ status: 500, body: {}, headers: withReqId("req_abc123") });
    expect(err.requestId).toBe("req_abc123");
  });

  it("parses string bodies as JSON, falls back to message text", () => {
    const stringErr = mapHttpError({
      status: 500,
      body: JSON.stringify({ message: "boom" }),
      headers: noHeaders,
    });
    expect(stringErr.message).toBe("boom");

    const plainErr = mapHttpError({ status: 500, body: "not json", headers: noHeaders });
    expect(plainErr.message).toBe("not json");
  });
});

describe("connectionError", () => {
  it("wraps an Error cause and surfaces its message", () => {
    const cause = new Error("ECONNREFUSED");
    const err = connectionError(cause);
    expect(err.message).toBe("ECONNREFUSED");
    expect(err.raw).toBeUndefined();
    expect((err as Error).cause).toBe(cause);
  });

  it("uses the override message when provided", () => {
    const err = connectionError(new Error("x"), "transient network glitch");
    expect(err.message).toBe("transient network glitch");
  });
});
