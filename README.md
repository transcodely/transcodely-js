# @transcodely/sdk

Official TypeScript / Node SDK for [Transcodely](https://www.transcodely.com) — encode
video into HLS, DASH and MP4 and write it to your own S3, GCS or R2 bucket, with DRM,
signed playback and deterministic output paths. Or let Transcodely host and deliver it.

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
  // Write outputs to Transcodely-managed storage. Drop `managed` and set
  // `outputOriginId: "ori_..."` to write to your own configured origin.
  managed: true,
  outputs: [{
    type: OutputFormat.HLS,
    video: [
      { codec: VideoCodec.H264, resolution: Resolution.RESOLUTION_1080P },
      { codec: VideoCodec.H264, resolution: Resolution.RESOLUTION_720P },
    ],
  }],
  // Optional: encode only a sub-range of the input. Applies job-wide and
  // reduces cost (billing keys off the produced output duration). Omit
  // `endSeconds` (or leave 0) to encode through to the end of the input.
  clip: { startSeconds: 2, endSeconds: 7 },
});

console.log(job.id); // "job_a1b2c3d4e5f6"

// Watch progress in real time
for await (const event of client.jobs.watch(job.id)) {
  console.log(event.job?.status, event.job?.progress);
  if (event.job?.status === 4 /* COMPLETED */) break;
}
```

## Upload a file

`client.uploads.putFile` takes a file from your disk to a hosted, playable
video in one call. It opens the upload, pushes the bytes straight to object
storage, and tells the API the bytes landed — the API never proxies the media.

```ts
const video = await client.uploads.putFile("./talk.mp4", {
  appId: "app_k1l2m3n4o5",
  title: "Conference talk",
  onProgress: (p) => process.stdout.write(`\r${p.percent}%`),
});

console.log(video.id, video.status); // "vid_a1b2c3d4e5f6g7" "processing"
```

The transcode starts on its own as soon as the upload completes, so the video
comes back already `processing`. Follow it with `client.videos.watch(video.id)`
until it reaches `ready` (or `error`, or `deleted`), or subscribe to the
`video.ready` webhook.

**The app does not need managed hosting turned on first.** An app that has never
hosted anything is provisioned by the create call itself — bucket, managed
origin and CDN pull zone — which is why a first upload takes a few seconds
longer than the ones after it. Two things can still refuse it, and they are
worth telling apart:

- `hosting_provisioning_failed` — provisioning did not complete. Nothing was
  created, so the identical call is safe to retry.
- a billing or admission code — `billing_past_due`,
  `outstanding_balance_exceeded`, `limit_exceeded`, `intake_paused`,
  `app_suspended`. These are about the account, not about hosting, and retrying
  will not clear them.

**Sources.** A filesystem path, a `Blob`/`File`, or a `ReadableStream`. A path
and a `File` supply their own name and size; a bare `Blob` needs `filename`,
and a stream needs both `filename` and `sizeBytes` because the API has to know
the total before the first byte moves.

```ts
await client.uploads.putFile(blob, { appId, filename: "talk.mp4" });
await client.uploads.putFile(stream, { appId, filename: "talk.mp4", sizeBytes: 734003200 });
```

**How it moves the bytes.** A file that fits in one part goes up as a single
`PUT`. Anything larger becomes an S3 multipart upload: parts are uploaded
`concurrency` at a time (default 4), a part that fails on a 5xx, 429, 408 or a
network error is retried with jittered backoff, and a presigned URL that has
expired is re-signed and retried. If the upload cannot finish, the multipart
upload is aborted server-side before the error is thrown — nothing sweeps
orphaned multipart uploads, so an abandoned one would cost storage forever.

**Knobs.**

| Option | Default | Notes |
| --- | --- | --- |
| `partSize` | 25 MiB | Raised to the 5 MiB S3 minimum, and further if 10,000 parts would not cover the file. |
| `concurrency` | 4 | Parts in flight at once. For a stream source this also caps how much is buffered. |
| `maxRetries` | 4 | Retries per part, after the first attempt. |
| `signal` | — | Aborts the upload and the multipart upload behind it. |
| `onProgress` | — | Called once per completed part, not per byte. |

**Limits and errors.** The platform ceiling is 5 GB; an empty file or one over
the ceiling is refused before the first request. Transfer failures throw
`UploadError` (`UploadAbortedError` when your `signal` fired); everything the
API itself refuses keeps its usual error class.

```ts
import { UploadAbortedError, UploadError } from "@transcodely/sdk";
```

Need finer control? The individual RPCs are still there on `client.videos`
(`createUpload`, `createMultipartUpload`, `getUploadPartUrls`,
`completeMultipartUpload`, `abortMultipartUpload`).

## Command line

The same flows from a shell, with no code:

```bash
npx transcodely ./talk.mp4
npx transcodely https://example.com/talk.mp4 --wait
```

**Not published yet.** The `transcodely` CLI lives in this repository under
[`packages/cli`](packages/cli/README.md) and ships once this SDK releases the
version it pins. Until then the commands above do not resolve on npm; build it
from the repo instead (`pnpm install && pnpm build`, then
`node packages/cli/dist/index.mjs --help`).

## Read the output report

Every completed output carries a report of what the produced file actually
turned out to be — measured from the encoded file rather than copied from the
request — plus the verdict of comparing those measurements against what was
asked for.

```ts
import type { OutputReport } from "@transcodely/sdk";

const done = await client.jobs.get(job.id);

for (const output of done.outputs) {
  const report: OutputReport | undefined = output.report;
  if (!report) continue; // not measured — never "nothing wrong"

  console.log(
    output.id,
    report.video?.codec,
    `${report.video?.width}x${report.video?.height}`,
    `${report.durationSeconds}s`,
  );

  if (report.verdict && !report.verdict.matchesRequest) {
    for (const m of report.verdict.mismatches) {
      console.log(`  ${m.field}: asked for ${m.expected}, got ${m.actual}`);
    }
  }
}
```

Branch on `m.field` — it comes from a fixed vocabulary (`video.codec`,
`video.resolution`, `duration_seconds`, …) — rather than on the values beside
it. For an ABR ladder the facts describe the highest-resolution rendition, the
same one the verdict judges; per-rendition detail stays in `variantResults`.

An output encoded with per-title content-aware analysis also carries
`report.contentAware`: the VMAF target the search aimed at, the score it reached
on its samples, and the CRF it chose. It describes the SEARCH, not the delivered
file — `vmafAchieved` scores short samples taken before the real encode, which is
never scored itself. It is `undefined` on every ordinary output.

## AI captions

Add auto-generated captions to any output with a `generate` subtitle track.
Leave `language` empty (or set `"auto"`) to auto-detect the spoken language, or
pass an ISO 639-2 code to force one. A per-job fee is metered by source minute
and surfaced on `job.fees`; the produced captions show up on `job.subtitleResults`
with `autoGenerated: true`.

```ts
import { Transcodely, OutputFormat, VideoCodec, Resolution, SubtitleOperation } from "@transcodely/sdk";

const client = new Transcodely({ apiKey: process.env.TRANSCODELY_API_KEY! });

// Generate captions while transcoding a new source.
await client.jobs.create({
  inputUrl: "https://example.com/source.mp4",
  managed: true,
  outputs: [{
    type: OutputFormat.HLS,
    video: [{ codec: VideoCodec.H264, resolution: Resolution.RESOLUTION_1080P }],
    subtitleTracks: [{ operation: SubtitleOperation.GENERATE, language: "auto" }],
  }],
});

// Retro-caption a video you've already hosted: reference it by inputVideoId and
// request a single captions-only output (no video encode).
const job = await client.jobs.create({
  inputVideoId: "vid_a1b2c3d4e5f6g7",
  outputs: [{ subtitleTracks: [{ operation: SubtitleOperation.GENERATE }] }],
});

for (const result of job.subtitleResults) {
  console.log(result.language, result.autoGenerated, result.url);
}
for (const fee of job.fees) {
  console.log(fee.feeType, fee.amount, fee.currency); // "captions" 0.51 "eur"
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
client.uploads         // putFile — the whole create / PUT / complete upload, for a path, Blob or stream
client.videos          // upload RPCs, multipart, createFromUrl, get / list / update / delete / watch / getStats / listTopVideos
client.presets         // create / get / getBySlug / list / update / duplicate / archive
client.origins         // create / get / list / update / validate / archive
client.ingestRules     // create / get / list / update / delete / listEvents / test / replayEvent
client.apps            // create / get / list / update / archive / enableHosting
client.apiKeys         // create / get / list / revoke
client.organizations   // create / get / list / update / checkSlug
client.memberships     // list / get / updateRole / remove
client.users           // getMe / get / list / updateMe
client.health          // check
```

Every enum in the API schema is exported by name from the package root, so you
can branch on one without reaching into the generated code:

```ts
import { HealthStatus } from "@transcodely/sdk";

const health = await client.health.check();
for (const component of health.components) {
  if (component.status !== HealthStatus.HEALTHY) {
    console.warn(component.name, component.message);
  }
}
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

## Ingest rules

An ingest rule is a standing instruction on one readable origin: *when an object
matching these filters lands, create this job for it*. Your storage provider
posts its object-created events to the rule's endpoint, and no server of yours
is in the path. Amazon S3 via SNS, Google Cloud Storage via a Pub/Sub push
subscription, Supabase Storage via a database webhook, and a generic shape for
anything else are all recognised from the payload.

```ts
const { rule, secret } = await client.ingestRules.create({
  originId: "ori_a1b2c3d4e5f6",
  name: "Watch uploads/",
  filters: {
    prefix: "uploads/",
    suffixes: [".mp4", ".mov"],
    minBytes: 1024n, // ignore the zero-byte placeholder some clients write first
  },
  action: {
    outputs: [{ preset: "web_1080p_standard" }],
    managed: true, // host and deliver the result; set outputOriginId for your own bucket
    priority: JobPriority.STANDARD,
  },
});

console.log("point your bucket notifications at", rule!.endpointUrl);
console.log("secret (shown once):", secret);
```

`secret` is the **only** time the inbound secret is readable — store it wherever
the event sender will read it from. A later `get` returns just `secretPrefix`
and `secretHint`. Lost it? `update` with `rotateSecret: true` issues a new one,
and the previous one keeps working for 24 hours so the sender can be changed
without dropping an event.

Every delivery is recorded, whether or not it became a job:

```ts
for await (const event of client.ingestRules
  .listEvents({ ruleId: rule!.id })
  .autoPage()) {
  console.log(event.id, event.source, event.objectKey, event.status, event.reason);
}
```

A `SKIPPED` event names why in `reason` — `filter_prefix`, `filter_suffix`,
`filter_content_type`, `filter_size`, `bucket_mismatch`, `rule_disabled`, or
`duplicate`. A `FAILED` one carries the API error code that refused the job,
such as `limit_exceeded`.

Deduplication is permanent: an object is identified by (rule, bucket, key,
etag), so re-sending the event or re-uploading the same bytes produces nothing.
To give an object another pass — one that arrived while the rule was paused, or
was refused while the account was over its cap — replay it:

```ts
const replayed = await client.ingestRules.replayEvent("sev_a1b2c3d4e5f6g7");
console.log(replayed.id, "is back in", StorageEventStatus[replayed.status]);
```

Only `SKIPPED` and `FAILED` events can be replayed. When an `update` switches a
paused rule back on, the response reports how large that backlog is in
`eventsSkippedWhileDisabled`.

Before wiring the provider up, dry-run a key against the rule with
`client.ingestRules.test(...)`: it reports whether the filters match and, when
they do, the exact job request the rule would submit. Nothing is stored.

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
