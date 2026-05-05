# transcodely

Official TypeScript / Node SDK for the [Transcodely](https://transcodely.com) video transcoding API.

```bash
npm install transcodely
```

## Quick start

```ts
import { Transcodely, OutputFormat, VideoCodec, Resolution } from "transcodely";

const client = new Transcodely({ apiKey: process.env.TRANSCODELY_API_KEY! });

// Create a job
const job = await client.jobs.create({
  inputUrl: "https://example.com/source.mp4",
  outputs: [{
    type: OutputFormat.HLS,
    video: [
      { codec: VideoCodec.H264, resolution: Resolution.RESOLUTION_1080P },
      { codec: VideoCodec.H264, resolution: Resolution.RESOLUTION_720P },
    ],
  }],
});

console.log(job.id); // "job_a1b2c3d4e5f6"

// Watch progress in real time
for await (const event of client.jobs.watch(job.id)) {
  console.log(event.job?.status, event.job?.progress);
  if (event.job?.status === 4 /* COMPLETED */) break;
}
```

## Authentication

Pass your API key in the constructor:

```ts
const client = new Transcodely({ apiKey: process.env.TRANSCODELY_API_KEY! });
```

Test-mode keys (`ak_test_*`) and live-mode keys (`ak_live_*`) hit the same base URL — the environment is encoded in the key prefix.

## Resources

```ts
client.jobs            // create / get / list / cancel / confirm / watch
client.videos          // upload helpers, multipart, get / list / update / delete / watch
client.presets         // create / get / getBySlug / list / update / duplicate / archive
client.origins         // create / get / list / update / validate / archive
client.apps            // create / get / list / update / archive / enableHosting
client.apiKeys         // create / get / list / revoke
client.organizations   // create / get / list / update / checkSlug
client.memberships     // list / get / updateRole / remove
client.users           // getMe / get / list / updateMe
client.health          // check
```

## Errors

All SDK errors extend `TranscodelyError`:

```ts
import { TranscodelyError, InvalidRequestError, RateLimitError } from "transcodely";

try {
  await client.jobs.create(params);
} catch (err) {
  if (err instanceof InvalidRequestError) {
    for (const v of err.errors) console.warn(`${v.field}: ${v.description}`);
  } else if (err instanceof RateLimitError) {
    await new Promise((r) => setTimeout(r, err.retryAfterMs ?? 1000));
  } else if (err instanceof TranscodelyError) {
    console.error(err.code, err.message, err.requestId);
  } else {
    throw err;
  }
}
```

The hierarchy:

| Class | Status | When |
|---|---|---|
| `APIConnectionError` | — | Network / DNS / TLS failure |
| `APIError` | 5xx | Server-side error |
| `AuthenticationError` | 401 | Bad / missing / revoked key |
| `PermissionError` | 403 | Authenticated but forbidden |
| `NotFoundError` | 404 | Resource doesn't exist |
| `ConflictError` | 409 | Idempotency conflict, slug taken |
| `RateLimitError` | 429 | Carries `retryAfterMs` |
| `InvalidRequestError` | 400 | Carries `errors` (`FieldViolation[]`) |
| `PreconditionError` | 412 | Wrong state (e.g. job not cancelable) |

Every error carries `requestId`, `code`, `httpStatus`, and `raw` for debugging.

## Pagination

Every `list` method returns a `Page` you can either await for one page or auto-iterate:

```ts
// One page
const page = await client.jobs.list({ pagination: { limit: 50 } });
console.log(page.items, page.nextCursor);

// All items, automatically across pages
for await (const job of client.jobs.list({ pagination: { limit: 50 } }).autoPage()) {
  console.log(job.id);
}
```

## Idempotency

`jobs.create` accepts an `idempotencyKey` field. The SDK auto-generates a UUID if you don't pass one, so retries are always safe. For cross-process safety, pass your own:

```ts
await client.jobs.create({
  inputUrl: "...",
  outputs: [...],
  idempotencyKey: "create-job-for-asset-12345",
});
```

For all other write methods, the SDK ships `Idempotency-Key` HTTP header automatically.

## Streaming watch

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 30_000); // give up after 30s

for await (const event of client.jobs.watch(job.id, { signal: ac.signal })) {
  console.log(event.event, event.job?.status, event.job?.progress);
}
```

The SDK auto-reconnects on transient network failures (Watch is read-only, so resumption is idempotent — every reconnect emits a fresh `SNAPSHOT` event). Heartbeat events are filtered by default; pass `includeHeartbeats: true` to see them.

## Configuration

```ts
new Transcodely({
  apiKey: string,                          // required
  baseUrl?: string,                        // default: https://api.transcodely.com
  timeoutMs?: number,                      // unary-call timeout, default 30s
  maxRetries?: number,                     // default 3
  apiVersion?: string,                     // override the pinned API version
  defaultHeaders?: Record<string, string>, // sent on every request
  fetchImpl?: typeof fetch,                // for browser DI / testing
  logger?: (event: LogEvent) => void,      // structured request logger
});
```

## Request IDs

Each response carries `X-Request-Id`. Stripe-style:

```ts
console.log(client.lastRequestId); // "req_*"

try { await client.jobs.create(...); }
catch (err) {
  if (err instanceof TranscodelyError) console.error("failed:", err.requestId);
}
```

## Wire format

The SDK uses Connect-RPC over HTTP+JSON with snake_case field names and lowercase simplified enum values (e.g. `"pending"` instead of `"JOB_STATUS_PENDING"`). A custom codec handles the transformation transparently — the surface you write against is fully typed.

## Versioning

The SDK is versioned independently with semver, starting at `0.1.0`. Breaking changes are allowed on minor bumps until `1.0.0`. Each release pins a specific calendar-versioned API (`Transcodely.API_VERSION`) and sends `Transcodely-Version` on every request.

## License

[MIT](LICENSE).
