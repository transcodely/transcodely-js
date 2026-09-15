# transcodely

Transcode, host and deliver a video from the command line.

```bash
npx transcodely ./talk.mp4
```

That single command uploads the file, encodes it into an adaptive ladder, hosts
it, and hands back a playable link. There is no project to set up and no bucket
to configure first: an app that has never hosted anything is provisioned by that
first call, which is why it takes a few seconds longer than the ones after it.
If that provisioning fails you get `hosting_provisioning_failed`, nothing is
created, and the same command is safe to run again.

Node 20 or newer. The CLI sends no telemetry.

## Install

Run it without installing:

```bash
npx transcodely --help
```

Or keep it around:

```bash
npm install -g transcodely
```

## Authenticate

You need an API key from the dashboard. Three ways to supply it, highest
priority first:

```bash
export TRANSCODELY_API_KEY=ak_…       # wins over everything saved
transcodely login --api-key ak_…      # saves it
echo "$KEY" | transcodely login       # same, reading stdin
transcodely --api-key ak_… <file>     # one command only
```

A key passed as `--api-key` lands in your shell history and is visible in `ps`
while the command runs. Piping it or exporting it avoids both.

`transcodely login` proves the key with one authenticated read before saving
it, so a typo fails immediately instead of on your next command.

Where the key is saved, in order of preference:

1. the macOS keychain, via `security`;
2. the freedesktop secret service, via `secret-tool`;
3. `$XDG_CONFIG_HOME/transcodely/config.json` (default `~/.config`), written
   `0600` inside a `0700` directory.

The secret is base64-encoded and handed to the keychain tool on **stdin**, so it
never appears in a process argument list. If the keychain refuses the write —
`secret-tool` installed with no Secret Service running is the common case on a
headless box — the CLI falls back to the file, says so on stderr, and stays
usable. A helper that never answers is killed after five seconds and treated as
unavailable, rather than hanging the command. Set
`TRANSCODELY_CONFIG_STORE=file` to skip the keychain entirely, which is what you
want on a CI runner.

The `0600` above is POSIX. On Windows there is no keychain backend and Node's
`chmod` only toggles the read-only bit, so the file is protected by the user
profile's own permissions and nothing more.

`transcodely logout` clears the saved record. It cannot clear
`TRANSCODELY_API_KEY` out of your shell, and says so when that is set.

## Encode and host

```bash
# A local file: uploaded, transcoded, hosted.
transcodely ./talk.mp4 --title "Conference talk"

# A public URL: ingested without the bytes ever touching your machine.
transcodely https://example.com/talk.mp4 --wait

# Your own bucket instead of managed delivery (URL inputs only).
transcodely https://example.com/talk.mp4 --own-bucket ori_a1b2c3d4e5f6 --hls

# A single 1080p MP4 rather than an HLS ladder.
transcodely https://example.com/talk.mp4 --mp4
```

| Flag | Meaning |
| --- | --- |
| `--own-bucket ori_…` | Write outputs to your own storage origin instead of managed delivery. URL inputs only. |
| `--hls` | Produce an HLS ladder: 1080p / 720p / 480p, H.264. |
| `--mp4` | Produce one 1080p H.264 MP4. |
| `--preset pst_…` | Encode with a preset, by id or slug. |
| `--title`, `--visibility` | Metadata for the hosted video. `public`, `unlisted` or `private`. |
| `--wait` | Stay attached until the job or video reaches a final state. |
| `--part-size`, `--concurrency` | Upload tuning. Defaults: 25 MiB parts, 4 at a time. |

**Why `--own-bucket` is refused for a local file.** Uploaded bytes always land
in Transcodely-managed storage, and the API resolves an uploaded video's job
input itself with managed output forced. There is no honest mapping from
"upload these bytes" to "write them to your bucket", so the CLI says so instead
of quietly writing somewhere you did not ask for. Shape an uploaded file's
encode with `--preset`.

## Inspect

```bash
transcodely jobs ls --limit 10 --status completed
transcodely jobs get job_a1b2c3d4e5f6
transcodely videos get vid_a1b2c3d4e5f6g7
```

## Scripting

`--json` puts exactly one JSON document on stdout and moves every diagnostic to
stderr, so a pipe always parses — on failure too, where the document is
`{"error": {"code", "message", "errors", "request_id"}}`. On success the shape is
the API's own wire format: `snake_case` fields, lowercase enums.

```bash
id=$(transcodely ./talk.mp4 --json | jq -r .id)
transcodely videos get "$id" --json | jq -r .playback_url
```

Exit codes are the contract:

| Code | Meaning |
| --- | --- |
| `0` | It worked. |
| `1` | The API refused. The error code, message, any field violations and the request id go to stderr. |
| `2` | The command line was wrong. |

With `--wait`, only a clean finish exits `0`: a job must reach `completed` and a
video must reach `ready`. `failed`, `canceled` and `partial` jobs, and `error` or
`deleted` videos, all exit `1` — a script checking `$?` should not have to know
which kind of not-finished it got.

Flags may go before or after the input (`transcodely --json ./talk.mp4` and
`transcodely ./talk.mp4 --json` are the same command). A subcommand, when you
use one, comes first.

## Which app?

Uploads and URL ingest are scoped to an app. The CLI resolves it from `--app
app_…`, then `TRANSCODELY_APP_ID`, then whatever `transcodely login --app
app_…` saved. `--own-bucket` and the format flags go through the job API, which
infers the app from the key itself and needs none of this.

## Environment

| Variable | Effect |
| --- | --- |
| `TRANSCODELY_API_KEY` | API key. Outranks anything saved by `login`. |
| `TRANSCODELY_APP_ID` | Default app. |
| `TRANSCODELY_BASE_URL` | API base URL, for staging or a local stack. |
| `TRANSCODELY_CONFIG_STORE=file` | Skip the keychain; use the config file. |

## Development

This package lives in the [`transcodely-js`](https://github.com/transcodely/transcodely-js)
repository alongside `@transcodely/sdk`, which it depends on. From the repo
root:

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
node packages/cli/dist/index.mjs --help
```

**Published as `transcodely` on npm** since cli 0.1.1, pinned to a released
`@transcodely/sdk` (the version in `package.json`). Bump that pin when the CLI
needs a newer SDK feature; the release workflow's `publish-cli` job publishes
with npm provenance.

## License

MIT
