/**
 * The default command: `transcodely <file|url>`.
 *
 * Four shapes, decided by the target and two flags:
 *
 *   file, managed        upload the bytes; the API's own transcode follows
 *   url, managed         VideoService.CreateFromUrl — one call, no bytes
 *   url + --hls/--mp4    JobService.Create with an explicit output ladder
 *   url + --own-bucket   the same, writing to the caller's origin
 *
 * A file plus --own-bucket has no honest mapping: uploaded bytes always land
 * in managed storage (the API resolves an uploaded video's job input itself
 * and forces managed output), so the CLI refuses rather than quietly writing
 * somewhere the caller did not ask for.
 */

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";

import {
  JobStatus,
  OutputFormat,
  Resolution,
  TranscodelyError,
  VideoCodec,
  type Job,
  type Video,
} from "@transcodely/sdk";

import { openSession, requireApp, type Ctx } from "../context.js";
import { EXIT_OK, UsageError } from "../errors.js";
import { META_OPTIONS, meta } from "../meta.js";
import { fields, formatBytes, printer, wire } from "../output.js";

const OPTIONS = {
  "own-bucket": { type: "string" },
  preset: { type: "string" },
  hls: { type: "boolean" },
  mp4: { type: "boolean" },
  wait: { type: "boolean" },
  json: { type: "boolean" },
  title: { type: "string" },
  visibility: { type: "string" },
  app: { type: "string" },
  "api-key": { type: "string" },
  "base-url": { type: "string" },
  "part-size": { type: "string" },
  concurrency: { type: "string" },
  ...META_OPTIONS,
} as const;

const TERMINAL_JOB = new Set([
  JobStatus.COMPLETED,
  JobStatus.FAILED,
  JobStatus.CANCELED,
  JobStatus.PARTIAL,
]);

/**
 * The API's own terminal set for a hosted video — `domain.Video.IsTerminal` is
 * ready | error | deleted. There is no "failed" video status (that is a job
 * word), and "archived" is deliberately not terminal.
 */
export const TERMINAL_VIDEO = new Set(["ready", "error", "deleted"]);

/** Only a clean finish is a success; everything else terminal exits 1. */
const VIDEO_SUCCESS = "ready";

function positiveInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`${flag} must be a positive integer, got "${raw}"`);
  }
  return n;
}

export async function uploadCommand(ctx: Ctx, argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const flags = parsed.values;
  const asked = meta(ctx, flags);
  if (asked !== undefined) return asked;

  const target = parsed.positionals[0];
  if (!target) throw new UsageError("give me a file path or an http(s) URL to encode");
  if (parsed.positionals.length > 1) {
    throw new UsageError("one input at a time — got " + String(parsed.positionals.length));
  }
  if (flags.hls && flags.mp4) throw new UsageError("--hls and --mp4 are mutually exclusive");

  const out = printer(ctx, flags.json ?? false);
  const session = await openSession(ctx, {
    ...(flags["api-key"] !== undefined ? { apiKey: flags["api-key"] } : {}),
    ...(flags.app !== undefined ? { app: flags.app } : {}),
    ...(flags["base-url"] !== undefined ? { baseUrl: flags["base-url"] } : {}),
  });

  const isUrl = /^https?:\/\//i.test(target);
  const otherScheme = !isUrl && /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
  if (otherScheme) {
    throw new UsageError(
      `"${target}" is not something I can read. Give me a local file path or an http(s) URL — ` +
        "storage-origin schemes go through an origin and a job, not this command.",
    );
  }
  const wantsJob = Boolean(flags["own-bucket"] ?? flags.hls ?? flags.mp4);

  if (!isUrl && wantsJob) {
    throw new UsageError(
      "uploaded bytes always land in Transcodely-managed storage, so --own-bucket, --hls and --mp4 " +
        "only apply to an http(s) URL input. For an uploaded file, shape the encode with --preset.",
    );
  }

  if (isUrl && wantsJob) return await createJob(ctx, session, flags, target, out);
  if (isUrl) return await ingestUrl(session, flags, target, out);
  return await uploadFile(ctx, session, flags, target, out);
}

type Flags = { [K in keyof typeof OPTIONS]?: string | boolean } & Record<string, unknown>;
type Out = ReturnType<typeof printer>;

async function uploadFile(
  ctx: Ctx,
  session: Awaited<ReturnType<typeof openSession>>,
  flags: Flags,
  path: string,
  out: Out,
): Promise<number> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new UsageError(`${path} is not a file`);
    size = info.size;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const appId = requireApp(session);
  out.note(`Uploading ${basename(path)} (${formatBytes(size)})…`);

  let lastPercent = -1;
  const video = await session.client.uploads.putFile(path, {
    appId,
    ...(flags.title !== undefined ? { title: flags.title as string } : {}),
    ...(flags.visibility !== undefined ? { visibility: flags.visibility as string } : {}),
    ...(flags.preset !== undefined ? { preset: flags.preset as string } : {}),
    ...(positiveInt(flags["part-size"] as string | undefined, "--part-size") !== undefined
      ? { partSize: positiveInt(flags["part-size"] as string | undefined, "--part-size")! }
      : {}),
    ...(positiveInt(flags.concurrency as string | undefined, "--concurrency") !== undefined
      ? { concurrency: positiveInt(flags.concurrency as string | undefined, "--concurrency")! }
      : {}),
    onProgress: (p) => {
      if (out.json || p.percent === lastPercent) return;
      lastPercent = p.percent;
      ctx.stderr(
        ctx.isTTY
          ? `\rUploading… ${String(p.percent)}% (${String(p.partsCompleted)}/${String(p.totalParts)} parts)`
          : `Uploading… ${String(p.percent)}%\n`,
      );
    },
  });
  if (!out.json && ctx.isTTY) ctx.stderr("\n");

  return await finish(session, flags, video, out);
}

async function ingestUrl(
  session: Awaited<ReturnType<typeof openSession>>,
  flags: Flags,
  url: string,
  out: Out,
): Promise<number> {
  const appId = requireApp(session);
  out.note(`Ingesting ${url}…`);
  const video = await session.client.videos.createFromUrl({
    appId,
    url,
    ...(flags.title !== undefined ? { title: flags.title as string } : {}),
    ...(flags.visibility !== undefined ? { visibility: flags.visibility as string } : {}),
    ...(flags.preset !== undefined ? { preset: flags.preset as string } : {}),
  });
  return await finish(session, flags, video, out);
}

/** The output ladder the format flags stand for. HLS is the default shape. */
function outputs(mp4: boolean): { type: OutputFormat; video: { codec: VideoCodec; resolution: Resolution }[] }[] {
  if (mp4) {
    return [
      {
        type: OutputFormat.MP4,
        video: [{ codec: VideoCodec.H264, resolution: Resolution.RESOLUTION_1080P }],
      },
    ];
  }
  return [
    {
      type: OutputFormat.HLS,
      video: [
        { codec: VideoCodec.H264, resolution: Resolution.RESOLUTION_1080P },
        { codec: VideoCodec.H264, resolution: Resolution.RESOLUTION_720P },
        { codec: VideoCodec.H264, resolution: Resolution.RESOLUTION_480P },
      ],
    },
  ];
}

async function createJob(
  ctx: Ctx,
  session: Awaited<ReturnType<typeof openSession>>,
  flags: Flags,
  url: string,
  out: Out,
): Promise<number> {
  const ownBucket = flags["own-bucket"] as string | undefined;
  if (ownBucket !== undefined && !/^ori_/.test(ownBucket)) {
    throw new UsageError(`--own-bucket wants an origin id starting with "ori_", got "${ownBucket}"`);
  }
  out.note(`Creating a job for ${url}…`);
  const job = await session.client.jobs.create({
    inputUrl: url,
    outputs: outputs(Boolean(flags.mp4)),
    ...(ownBucket !== undefined ? { outputOriginId: ownBucket } : { managed: true }),
    ...(session.appId !== undefined ? { appId: session.appId } : {}),
  });

  if (flags.wait) {
    const final = await waitForJob(session, job.id, out);
    out.result(wire(final));
    out.line(describeJob(final));
    // `completed` is the only clean finish. `failed`, `canceled` and `partial`
    // all mean the caller did not get what they asked for, so a script that
    // checks `$?` must see a failure for each of them.
    return final.status === JobStatus.COMPLETED ? EXIT_OK : 1;
  }
  out.result(wire(job));
  out.line(describeJob(job));
  out.line(`  Follow it with: transcodely jobs get ${job.id} --json`);
  return EXIT_OK;
}

async function finish(
  session: Awaited<ReturnType<typeof openSession>>,
  flags: Flags,
  video: Video,
  out: Out,
): Promise<number> {
  if (!flags.wait) {
    out.result(wire(video));
    out.line(describeVideo(video));
    out.line(`  Follow it with: transcodely videos get ${video.id} --json`);
    return EXIT_OK;
  }
  const final = await waitForVideo(session, video.id, out);
  out.result(wire(final));
  out.line(describeVideo(final));
  return final.status === VIDEO_SUCCESS ? EXIT_OK : 1;
}

async function waitForVideo(
  session: Awaited<ReturnType<typeof openSession>>,
  id: string,
  out: Out,
): Promise<Video> {
  let latest: Video | undefined;
  for await (const event of session.client.videos.watch(id)) {
    if (!event.video) continue;
    latest = event.video;
    out.note(`  ${latest.status}`);
    if (TERMINAL_VIDEO.has(latest.status)) break;
  }
  return latest ?? (await session.client.videos.get(id));
}

async function waitForJob(
  session: Awaited<ReturnType<typeof openSession>>,
  id: string,
  out: Out,
): Promise<Job> {
  let latest: Job | undefined;
  for await (const event of session.client.jobs.watch(id)) {
    if (!event.job) continue;
    latest = event.job;
    out.note(`  ${jobStatusName(latest.status)} ${String(latest.progress)}%`);
    if (TERMINAL_JOB.has(latest.status)) break;
  }
  return latest ?? (await session.client.jobs.get(id));
}

export function jobStatusName(status: JobStatus): string {
  return (JobStatus[status] ?? "unknown").toLowerCase();
}

export function describeVideo(video: Video): string {
  return [
    `Video ${video.id} — ${video.status}`,
    fields([
      ["title", video.title],
      ["playback", video.playbackUrl],
      ["embed", video.embedUrl],
      ["job", video.jobId],
    ]),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

export function describeJob(job: Job): string {
  return [
    `Job ${job.id} — ${jobStatusName(job.status)}`,
    fields([
      ["input", job.inputUrl],
      ["outputs", job.outputs.length > 0 ? String(job.outputs.length) : undefined],
      ["error", job.errorMessage],
    ]),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

/** Re-exported so main.ts can decide the exit code without importing the SDK. */
export function isApiError(err: unknown): err is TranscodelyError {
  return err instanceof TranscodelyError;
}
