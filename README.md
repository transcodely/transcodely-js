# @transcodely/sdk

Official TypeScript / Node SDK for the [Transcodely](https://transcodely.com) video transcoding API.

```bash
npm install @transcodely/sdk
```

## Quick start

```ts
import { Transcodely, OutputFormat, VideoCodec, Resolution } from "@transcodely/sdk";

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

## Resources

```ts
client.jobs            // create / get / list / cancel / confirm / watch
client.videos          // upload helpers, multipart, createFromUrl, get / list / update / delete / watch / getStats / listTopVideos
client.presets         // create / get / getBySlug / list / update / duplicate / archive
client.origins         // create / get / list / update / validate / archive
client.apps            // create / get / list / update / archive / enableHosting
client.apiKeys         // create / get / list / revoke
client.organizations   // create / get / list / update / checkSlug
client.memberships     // list / get / updateRole / remove
client.users           // getMe / get / list / updateMe
client.health          // check
```

## Origins

An origin tells Transcodely where to read source media from and where to write outputs. Every origin belongs to a single provider; pass exactly one provider-config field (`s3`, `gcs`, `http`, or `r2`) on create.

### Create an S3 origin

```ts
import { Transcodely, OriginPermission } from "@transcodely/sdk";

const origin = await client.origins.create({
  name: "Production S3",
  permissions: [OriginPermission.READ, OriginPermission.WRITE],
  s3: {
    bucket: "my-bucket",
    region: "us-east-1",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
    // endpoint: "https://s3.custom.example.com", // for MinIO, Wasabi, etc.
  },
});
```

### Create a GCS origin

```ts
import { Transcodely, OriginPermission } from "@transcodely/sdk";

const origin = await client.origins.create({
  name: "Production GCS",
  permissions: [OriginPermission.READ, OriginPermission.WRITE],
  gcs: {
    bucket: "my-gcs-bucket",
    credentials: {
      serviceAccountJson: process.env.GCS_SERVICE_ACCOUNT_JSON!,
    },
  },
});
```

### Create an HTTP origin

```ts
import { Transcodely, OriginPermission } from "@transcodely/sdk";

const origin = await client.origins.create({
  name: "Public CDN",
  permissions: [OriginPermission.READ], // HTTP origins are read-only
  http: {
    baseUrl: "https://media.example.com",
    credentials: {
      headers: { Authorization: `Bearer ${process.env.MEDIA_TOKEN!}` },
    },
  },
});
```

### Create an R2 origin

R2 supports two forms. With `accountId` (32-char hex) the endpoint is derived for you, optionally with a data-residency jurisdiction:

```ts
import { Transcodely, OriginPermission, R2Jurisdiction } from "@transcodely/sdk";

const origin = await client.origins.create({
  name: "Production R2",
  permissions: [OriginPermission.READ, OriginPermission.WRITE],
  r2: {
    bucket: "media",
    accountId: process.env.R2_ACCOUNT_ID!,
    jurisdiction: R2Jurisdiction.DEFAULT, // or .EU, .FEDRAMP
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY!,
      secretAccessKey: process.env.R2_SECRET_KEY!,
    },
  },
});
```

Or, with an explicit `endpoint` (custom domain bound to a bucket, or a jurisdiction not yet enumerated):

```ts
r2: {
  bucket: "media",
  endpoint: "https://media.example.com",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY!,
    secretAccessKey: process.env.R2_SECRET_KEY!,
  },
},
```

Provide either `accountId` or `endpoint`, never both. `jurisdiction` only applies when `accountId` is set.

## Webhooks

Transcodely signs every webhook delivery with HMAC-SHA-256 using your endpoint's `whsec_…` secret. Verify the signature before trusting the body — `client.webhooks.constructEvent` validates the signature, parses the envelope, and returns a typed event:

```ts
import express from "express";
import { Transcodely, WebhookSignatureError, WebhookTimestampError } from "@transcodely/sdk";

const client = new Transcodely({ apiKey: process.env.TRANSCODELY_API_KEY! });
const app = express();

app.post(
  "/webhooks/transcodely",
  express.raw({ type: "application/json" }),
  (req, res) => {
    try {
      const event = client.webhooks.constructEvent(
        req.body,
        req.header("transcodely-signature")!,
        process.env.WEBHOOK_SECRET!,
      );

      // `isKnownEvent` narrows `event` to the events this SDK types precisely,
      // so inside the switch `event.data` is the exact resource — no casts.
      if (client.webhooks.isKnownEvent(event)) {
        switch (event.type) {
          case "job.succeeded":
            console.log("Job done:", event.data.id); // event.data is a fully-typed Job
            break;
          case "video.uploaded":
            console.log("Video uploaded:", event.data.id); // event.data is a Video
            break;
          // ...handle the other known types you care about
        }
      } else {
        // Forward-compat: an event type added to the API after this SDK
        // release still verifies and parses; `event.data` is raw `unknown`.
        console.log("Unhandled future type:", event.type);
      }
      res.sendStatus(200);
    } catch (err) {
      if (err instanceof WebhookSignatureError || err instanceof WebhookTimestampError) {
        res.sendStatus(400);
        return;
      }
      throw err;
    }
  },
);
```

The signed payload is the **raw HTTP body** — use `express.raw()` (or the equivalent in your framework) to receive a `Buffer`, never `express.json()`.

#### Narrowing the event

`constructEvent` (and `client.events.retrieve` / `.list`) return a `WebhookEvent`: the closed, precisely-typed `KnownWebhookEvent` union **plus** an open `UnknownWebhookEvent` arm (`type: string; data: unknown`) so a payload for an event type added after this SDK release still verifies and parses instead of being dropped. That open arm means a bare `switch (event.type)` can't narrow `event.data` on its own — funnel through one of two guards first:

- **`isKnownEvent(event)`** narrows to `KnownWebhookEvent`, re-enabling a `switch (event.type)` where every `case` narrows `event.data` to the right resource (and TypeScript flags a `case` you left out if you keep the switch exhaustive). The `else` branch is your forward-compat handler.
- **`isEventType(event, "job.succeeded")`** narrows to a single event type — ideal for a receiver that only cares about one or two:

```ts
if (client.webhooks.isEventType(event, "output.ready")) {
  console.log(event.data.outputUrl); // event.data is a fully-typed JobOutput
}
```

Both are also exported standalone (`import { isKnownEvent, isEventType } from "@transcodely/sdk"`) for code that doesn't hold a client. `WebhookEvent`, `KnownWebhookEvent`, and `UnknownWebhookEvent` are all exported for annotating your own handler signatures.

Every event carries a `request` object. Events emitted **inside** an API request scope (e.g. `job.created`, from your `jobs.create` call) set `request.id` to the originating `req_*` ID. Events emitted **outside** a request scope — every worker-driven `job.*` / `output.*` event (`job.succeeded`, `job.failed`, `job.canceled`, `job.progress`, `output.ready`, …) — set `request.id` to `null`. `request.idempotencyKey` is `null` whenever the originating request didn't supply one.

`constructEvent` accepts `request.id: null` from **v0.1.3** onward. v0.1.2 and earlier rejected such deliveries with a `WebhookPayloadError` — upgrade if you validate worker-driven events.

### Multi-secret rotation

Pass an array to verify against both your previous and current secrets during a rotation window:

```ts
client.webhooks.constructEvent(body, sig, [process.env.PREVIOUS_SECRET!, process.env.CURRENT_SECRET!]);
```

### Manage endpoints

```ts
const endpoint = await client.webhookEndpoints.create({
  appId: "app_xyz",
  url: "https://example.com/webhooks/transcodely",
  enabledEvents: ["job.succeeded", "job.failed", "video.uploaded"],
});
console.log("Store this:", endpoint.secret); // only present on create + rotate

const rotated = await client.webhookEndpoints.rotateSecret(endpoint.id);
console.log("New secret:", rotated.secret);

for await (const ep of client.webhookEndpoints.list({ appId: "app_xyz" }).autoPage()) {
  console.log(ep.id, ep.url);
}

await client.webhookEndpoints.sendTest(endpoint.id, "job.succeeded");
```

### Replay an event

```ts
// Fetch a stored event (same shape as constructEvent returns)
const event = await client.events.retrieve("evt_…");
console.log(event.type, event.data);

// Requeue delivery — defaults to every subscribed endpoint, or pass
// `endpointIds` to target a subset.
await client.events.resend("evt_…");
```

## Errors

All SDK errors extend `TranscodelyError`:

```ts
import { TranscodelyError, InvalidRequestError, RateLimitError } from "@transcodely/sdk";

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

A few in-memory vs. on-the-wire representations are worth knowing:

- **64-bit integers** (byte sizes, millisecond durations — e.g. `sizeBytes`) are `bigint` in memory and serialize as decimal **strings** on the wire.
- **Enums** are numeric in memory but serialize to their lowercase string names via `toJSON()` (`JobStatus.COMPLETED` ⇄ `"completed"`).
- **`output_url` and thumbnail URL values are storage URLs** (e.g. `s3://bucket/key`, `gs://bucket/key`), not HTTP URLs — resolve them through your origin or CDN to fetch bytes.

### Measured output & input metadata

When an output completes, its `JobOutput` reports the real encoded geometry measured from the produced media — `width`, `height`, and `averageBitrateKbps`. For multi-variant outputs (ABR ladders) those aggregate the ladder, and `variantResults` (an `OutputVariantResult[]`, indexed like `variantPricing`) carries per-variant `width` / `height` / `averageBitrateKbps` / `sizeBytes`. Thumbnail results (`ThumbnailResult`) likewise carry their real rendered `width` / `height`.

On the input side, `VideoStreamInfo.rotation` exposes container rotation in degrees clockwise (`0` / `90` / `180` / `270`, absent when the stream has no rotation metadata), and `width` / `height` / `displayAspectRatio` are **display-oriented** — rotation is already applied, so they match what a player shows.

## Versioning

The SDK is versioned independently with semver, starting at `0.1.0`. Breaking changes are allowed on minor bumps until `1.0.0`. Each release pins a specific calendar-versioned API (`Transcodely.API_VERSION`) and sends `Transcodely-Version` on every request.

## License

[MIT](LICENSE).
