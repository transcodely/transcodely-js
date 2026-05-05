/**
 * Map a Connect-RPC error response (HTTP status + JSON body) to one of our
 * typed `TranscodelyError` subclasses.
 *
 * The Transcodely API returns Connect-style error bodies:
 * ```json
 * {
 *   "code": "invalid_argument",
 *   "message": "human-readable explanation",
 *   "details": [{
 *     "type": "transcodely.v1.ErrorDetails",
 *     "value": "...",
 *     "debug": {
 *       "code": "JOB_NOT_FOUND",
 *       "message": "...",
 *       "field_violations": [{ "field": "id", "description": "..." }]
 *     }
 *   }]
 * }
 * ```
 */

import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  PermissionError,
  PreconditionError,
  RateLimitError,
  type FieldViolation,
  type TranscodelyError,
} from "../errors.js";

interface ConnectErrorBody {
  code?: string;
  message?: string;
  details?: Array<{
    type?: string;
    value?: string;
    debug?: {
      code?: string;
      message?: string;
      field_violations?: FieldViolation[];
      fieldViolations?: FieldViolation[];
    };
  }>;
}

interface MapArgs {
  status: number;
  body: unknown;
  headers: Headers;
}

export function mapHttpError({ status, body, headers }: MapArgs): TranscodelyError {
  const requestId = headers.get("x-request-id") ?? undefined;
  const parsed = parseBody(body);
  const message = parsed.message ?? `HTTP ${status}`;
  const detail = parsed.details?.[0]?.debug;
  const code = detail?.code;
  const violations = detail?.field_violations ?? detail?.fieldViolations ?? [];
  const opts = {
    message,
    code,
    type: parsed.code,
    errors: violations,
    httpStatus: status,
    requestId,
    raw: body,
  };

  if (status === 401) return new AuthenticationError(opts);
  if (status === 403) return new PermissionError(opts);
  if (status === 404) return new NotFoundError(opts);
  if (status === 409) return new ConflictError(opts);
  if (status === 412) return new PreconditionError(opts);
  if (status === 422) return new InvalidRequestError(opts);
  if (status === 429) {
    const retry = headers.get("retry-after");
    const retryAfterMs = retry ? Math.max(0, parseInt(retry, 10) * 1000) : undefined;
    return new RateLimitError({ ...opts, retryAfterMs });
  }
  if (status >= 500) return new APIError(opts);
  if (status >= 400) return new InvalidRequestError(opts);
  return new APIError(opts);
}

export function connectionError(cause: unknown, message?: string): APIConnectionError {
  const msg =
    message ?? (cause instanceof Error ? cause.message : "network request failed");
  return new APIConnectionError({ message: msg, cause });
}

function parseBody(body: unknown): ConnectErrorBody {
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as ConnectErrorBody;
    } catch {
      return { message: body };
    }
  }
  if (typeof body === "object" && body !== null) return body as ConnectErrorBody;
  return {};
}
