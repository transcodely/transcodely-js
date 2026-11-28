/**
 * Makes sure the built artifacts exist before any test reads them.
 *
 * Builds on demand rather than skipping: in CI `pnpm test` runs before
 * `pnpm build`, and a suite that quietly passes without the artifact proves
 * nothing. Runs once, as vitest's global setup (vitest.config.ts): several
 * files need the build, and each building it on its own raced — one `tsup`
 * cleaned `dist/` while another file was reading it.
 */

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const run = promisify(execFile);

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const ARTIFACTS = [
  join(ROOT, "dist", "index.mjs"),
  join(ROOT, "dist", "index.cjs"),
  join(ROOT, "dist", "bin", "transcodely.mjs"),
  join(ROOT, "packages", "cli", "dist", "index.mjs"),
];

export async function ensureBuilt(): Promise<void> {
  const present = await Promise.all(
    ARTIFACTS.map((f) => access(f).then(() => true, () => false)),
  );
  if (present.includes(false)) {
    await run("pnpm", ["build"], { cwd: ROOT });
  }
  await Promise.all(ARTIFACTS.map((f) => access(f)));
}

/** vitest `globalSetup` entry point. */
export default async function setup(): Promise<void> {
  await ensureBuilt();
}
