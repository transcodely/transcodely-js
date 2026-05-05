/**
 * Error hierarchy for the Transcodely SDK. All errors thrown by SDK methods
 * inherit from {@link TranscodelyError}, so a single `catch` block plus
 * `instanceof` checks is enough for typed handling.
 *
 * @example
 * ```ts
 * try {
 *   await client.jobs.create(params);
 * } catch (err) {
 *   if (err instanceof InvalidRequestError) {
 *     for (const violation of err.errors) {
 *       console.warn(`${violation.field}: ${violation.description}`);
 *     }
 *   } else if (err instanceof RateLimitError) {
 *     await sleep(err.retryAfterMs ?? 1000);
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 */

export interface FieldViolation {
  field: string;
  description: string;
}

export interface ErrorPayload {
  /** Stripe-style top-level error type, e.g. "validation_error". */
  type?: string;
  /** Server-side machine-readable code, e.g. "JOB_NOT_FOUND". */
  code?: string;
  /** Human-readable explanation. */
  message?: string;
  /** Field-level validation errors (for InvalidRequestError). */
  errors?: FieldViolation[];
}

export interface TranscodelyErrorOptions {
  message: string;
  code?: string;
  type?: string;
  errors?: FieldViolation[];
  httpStatus?: number;
  requestId?: string;
  raw?: unknown;
  cause?: unknown;
}

/** Base class for every error the SDK throws. */
export class TranscodelyError extends Error {
  /** Server-side error code (e.g. "JOB_NOT_FOUND"). */
  readonly code: string | undefined;
  /** Top-level error type (e.g. "validation_error"). */
  readonly type: string | undefined;
  /** Field-level validation violations. */
  readonly errors: FieldViolation[];
  /** HTTP status code, if any. */
  readonly httpStatus: number | undefined;
  /** `req_*` ID returned by the server in `X-Request-Id`, if any. */
  readonly requestId: string | undefined;
  /** Raw response body or original error object. */
  readonly raw: unknown;

  constructor(opts: TranscodelyErrorOptions) {
    super(opts.message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = opts.code;
    this.type = opts.type;
    this.errors = opts.errors ?? [];
    this.httpStatus = opts.httpStatus;
    this.requestId = opts.requestId;
    this.raw = opts.raw;
  }
}

/** Network failure: DNS, TLS, connection refused, no HTTP response. */
export class APIConnectionError extends TranscodelyError {}

/** Server-side internal error (5xx). */
export class APIError extends TranscodelyError {}

/** 401 — invalid, missing, revoked, or expired API key. */
export class AuthenticationError extends TranscodelyError {}

/** 403 — authenticated but lacking permission for the requested resource. */
export class PermissionError extends TranscodelyError {}

/** 404 — entity not found. */
export class NotFoundError extends TranscodelyError {}

/** 409 — already exists, idempotency conflict, slug taken. */
export class ConflictError extends TranscodelyError {}

/** 429 — rate-limited. {@link retryAfterMs} reflects the `Retry-After` header. */
export class RateLimitError extends TranscodelyError {
  readonly retryAfterMs: number | undefined;
  constructor(opts: TranscodelyErrorOptions & { retryAfterMs?: number }) {
    super(opts);
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** 400 / 422 — request body or parameters were invalid. */
export class InvalidRequestError extends TranscodelyError {}

/** 412 — preconditions not met (e.g. job not cancelable in current state). */
export class PreconditionError extends TranscodelyError {}
