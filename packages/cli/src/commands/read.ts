/**
 * The read-only commands: `jobs ls`, `jobs get`, `videos get`.
 *
 * Nothing here mutates anything, so they are the safe way to poke at an
 * account from a script.
 */

import { parseArgs } from "node:util";

import { JobStatus, OutputStatus, type Job } from "@transcodely/sdk";

import { openSession, type Ctx } from "../context.js";
import { EXIT_OK, UsageError } from "../errors.js";
import { META_OPTIONS, meta } from "../meta.js";
import { fields, printer, table, wire } from "../output.js";
import { describeJob, describeVideo, jobStatusName } from "./upload.js";

const COMMON = {
  json: { type: "boolean" },
  app: { type: "string" },
  "api-key": { type: "string" },
  "base-url": { type: "string" },
  ...META_OPTIONS,
} as const;

const LIST_OPTIONS = { ...COMMON, limit: { type: "string" }, status: { type: "string" } } as const;

interface CommonFlags {
  json?: boolean | undefined;
  app?: string | undefined;
  "api-key"?: string | undefined;
  "base-url"?: string | undefined;
}

function usage(err: unknown): never {
  throw new UsageError(err instanceof Error ? err.message : String(err));
}

function sessionFlags(values: CommonFlags) {
  return {
    ...(values["api-key"] !== undefined ? { apiKey: values["api-key"] } : {}),
    ...(values.app !== undefined ? { app: values.app } : {}),
    ...(values["base-url"] !== undefined ? { baseUrl: values["base-url"] } : {}),
  };
}

export async function jobsCommand(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === "ls" || sub === "list") return await jobsList(ctx, argv.slice(1));
  if (sub === "get") return await jobsGet(ctx, argv.slice(1));
  return noSubcommand(
    ctx,
    argv,
    sub ? `unknown jobs subcommand "${sub}" — try ls or get` : "jobs needs a subcommand: ls or get",
  );
}

export async function videosCommand(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === "get") return await videosGet(ctx, argv.slice(1));
  return noSubcommand(
    ctx,
    argv,
    sub ? `unknown videos subcommand "${sub}" — try get` : "videos needs a subcommand: get",
  );
}

/**
 * No recognised subcommand. `jobs --help` is the only legitimate shape left, so
 * the argv is parsed to find out — rather than scanned, which could not tell
 * `--status help` from a request for help.
 */
function noSubcommand(ctx: Ctx, argv: string[], complaint: string): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: LIST_OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    usage(err);
  }
  const asked = meta(ctx, parsed.values);
  if (asked !== undefined) return Promise.resolve(asked);
  throw new UsageError(complaint);
}

async function jobsList(ctx: Ctx, argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: LIST_OPTIONS, allowPositionals: false, strict: true });
  } catch (err) {
    usage(err);
  }
  const flags = parsed.values;
  const asked = meta(ctx, flags);
  if (asked !== undefined) return asked;

  const out = printer(ctx, flags.json ?? false);
  const session = await openSession(ctx, sessionFlags(flags));

  const limit = flags.limit === undefined ? 20 : Number(flags.limit);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new UsageError(`--limit must be an integer between 1 and 100, got "${String(flags.limit)}"`);
  }

  const page = await session.client.jobs.list({
    pagination: { limit },
    ...(flags.status !== undefined ? { status: statusFromName(flags.status) } : {}),
  });

  out.result({ jobs: page.items.map((j) => wire(j)) });
  if (page.items.length === 0) {
    out.line("No jobs yet.");
    return EXIT_OK;
  }
  out.line(
    table(
      ["JOB", "STATUS", "PROGRESS", "INPUT"],
      page.items.map((j: Job) => [
        j.id,
        jobStatusName(j.status),
        `${String(j.progress)}%`,
        truncate(j.inputUrl, 48),
      ]),
    ),
  );
  return EXIT_OK;
}

async function jobsGet(ctx: Ctx, argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: COMMON, allowPositionals: true, strict: true });
  } catch (err) {
    usage(err);
  }
  const askedJob = meta(ctx, parsed.values);
  if (askedJob !== undefined) return askedJob;
  const id = parsed.positionals[0];
  if (!id) throw new UsageError("jobs get needs a job id (job_…)");
  const out = printer(ctx, parsed.values.json ?? false);
  const session = await openSession(ctx, sessionFlags(parsed.values));
  const job = await session.client.jobs.get(id);
  out.result(wire(job));
  out.line(describeJob(job));
  if (job.outputs.length > 0) {
    out.line(
      table(
        ["OUTPUT", "STATUS", "URL"],
        job.outputs.map((o) => [
          o.id,
          (OutputStatus[o.status] ?? "unknown").toLowerCase(),
          truncate(o.outputUrl ?? "", 60),
        ]),
      ),
    );
  }
  return EXIT_OK;
}

async function videosGet(ctx: Ctx, argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: COMMON, allowPositionals: true, strict: true });
  } catch (err) {
    usage(err);
  }
  const askedVideo = meta(ctx, parsed.values);
  if (askedVideo !== undefined) return askedVideo;
  const id = parsed.positionals[0];
  if (!id) throw new UsageError("videos get needs a video id (vid_…)");
  const out = printer(ctx, parsed.values.json ?? false);
  const session = await openSession(ctx, sessionFlags(parsed.values));
  const video = await session.client.videos.get(id);
  out.result(wire(video));
  out.line(describeVideo(video));
  if (video.renditions.length > 0) {
    out.line(fields([["renditions", video.renditions.map((r) => r.resolution).join(", ")]]));
  }
  return EXIT_OK;
}

/** `--status completed` → the enum the API wants. */
function statusFromName(name: string): JobStatus {
  const key = name.toUpperCase();
  const value = (JobStatus as unknown as Record<string, number | undefined>)[key];
  if (value === undefined || key === "UNSPECIFIED") {
    const known = Object.keys(JobStatus)
      .filter((k) => Number.isNaN(Number(k)) && k !== "UNSPECIFIED")
      .map((k) => k.toLowerCase())
      .join(", ");
    throw new UsageError(`unknown --status "${name}" — one of: ${known}`);
  }
  return value as JobStatus;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
