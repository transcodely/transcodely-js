/**
 * Command dispatch and the single place errors turn into exit codes.
 *
 * `run` takes its whole world as an argument and returns a number — it never
 * touches `process` — which is what lets the tests drive every command
 * in-process against a mock server.
 */

import { TranscodelyError } from "@transcodely/sdk";

import type { Ctx } from "./context.js";
import { loginCommand, logoutCommand } from "./commands/login.js";
import { jobsCommand, videosCommand } from "./commands/read.js";
import { uploadCommand } from "./commands/upload.js";
import { explain } from "./explain.js";
import { EXIT_API_ERROR, EXIT_OK, EXIT_USAGE, UsageError } from "./errors.js";
import { HELP } from "./help.js";
import { CLI_VERSION } from "./version.js";

const SUBCOMMANDS = new Set(["login", "logout", "jobs", "videos"]);

export async function run(ctx: Ctx): Promise<number> {
  // `--help` and `--version` win from anywhere on the line. The one casualty is
  // a literal `--help` used as a flag *value* (`--title --help`), which nobody
  // means; every other CLI in this space behaves the same way.
  if (ctx.argv.length === 0 || ctx.argv.some((a) => a === "help" || a === "--help" || a === "-h")) {
    ctx.stdout(HELP);
    return EXIT_OK;
  }
  if (ctx.argv.some((a) => a === "version" || a === "--version" || a === "-v")) {
    ctx.stdout(`${CLI_VERSION}\n`);
    return EXIT_OK;
  }

  const head = ctx.argv[0] ?? "";
  try {
    if (SUBCOMMANDS.has(head)) {
      const rest = ctx.argv.slice(1);
      switch (head) {
        case "login":
          return await loginCommand(ctx, rest);
        case "logout":
          return await logoutCommand(ctx, rest);
        case "jobs":
          return await jobsCommand(ctx, rest);
        default:
          return await videosCommand(ctx, rest);
      }
    }
    // Everything else is the default command, flags in any position. A genuinely
    // unknown option surfaces from strict parseArgs there, not from a guess made
    // here — which is what makes `transcodely --json ./talk.mp4` work.
    return await uploadCommand(ctx, ctx.argv);
  } catch (err) {
    return report(ctx, err);
  }
}

/** `--json` is a boolean flag, so its presence anywhere on the line is the mode. */
function jsonMode(argv: string[]): boolean {
  return argv.includes("--json");
}

function report(ctx: Ctx, err: unknown): number {
  const json = jsonMode(ctx.argv);

  if (err instanceof UsageError) {
    if (json) {
      ctx.stdout(
        `${JSON.stringify({ error: { code: "usage", message: err.message } }, null, 2)}\n`,
      );
    }
    ctx.stderr(`transcodely: ${err.message}\n`);
    ctx.stderr("Run `transcodely --help` for usage.\n");
    return EXIT_USAGE;
  }

  if (err instanceof TranscodelyError) {
    const code = err.code ?? err.type ?? (err.httpStatus ? `http_${String(err.httpStatus)}` : "error");
    if (json) {
      // The contract is one parseable document on stdout either way, so a
      // script can branch on `.error` instead of on an empty pipe.
      ctx.stdout(
        `${JSON.stringify(
          {
            error: {
              code,
              message: err.message,
              errors: err.errors,
              request_id: err.requestId ?? null,
            },
          },
          null,
          2,
        )}\n`,
      );
    }
    ctx.stderr(`transcodely: ${code}: ${err.message}\n`);
    const hint = explain(code);
    if (hint) ctx.stderr(`  ${hint}\n`);
    for (const violation of err.errors) {
      ctx.stderr(`  ${violation.field}: ${violation.description}\n`);
    }
    if (err.requestId) ctx.stderr(`  request id: ${err.requestId}\n`);
    return EXIT_API_ERROR;
  }

  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    ctx.stdout(`${JSON.stringify({ error: { code: "error", message } }, null, 2)}\n`);
  }
  ctx.stderr(`transcodely: ${message}\n`);
  return EXIT_API_ERROR;
}
