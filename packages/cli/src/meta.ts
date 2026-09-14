/**
 * `--help` and `--version` as real options rather than a scan of the argv.
 *
 * Scanning with `.some()` cannot tell an option from an option's *value*, so
 * `transcodely ./talk.mp4 --title help` printed the help text and exited 0
 * without uploading anything — a silent no-op reported as success, which is the
 * one failure shape a script cannot detect. `help` and `version` are ordinary
 * English words and a plausible title; letting strict `parseArgs` own the
 * distinction is the only way to keep them apart.
 *
 * Every command mixes {@link META_OPTIONS} into its own option set and calls
 * {@link meta} immediately after parsing, before any other validation, so
 * `transcodely --help` and `transcodely ./x.mp4 --help` both still work from
 * any position. The bare words `transcodely help` / `transcodely version` stay
 * a positional check in `main.ts`.
 */

import type { Ctx } from "./context.js";
import { EXIT_OK } from "./errors.js";
import { HELP } from "./help.js";
import { CLI_VERSION } from "./version.js";

export const META_OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

export interface MetaFlags {
  help?: boolean | undefined;
  version?: boolean | undefined;
}

/** Returns an exit code when the command was really a request for help. */
export function meta(ctx: Ctx, values: MetaFlags): number | undefined {
  if (values.help) {
    ctx.stdout(HELP);
    return EXIT_OK;
  }
  if (values.version) {
    ctx.stdout(`${CLI_VERSION}\n`);
    return EXIT_OK;
  }
  return undefined;
}
