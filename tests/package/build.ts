/**
 * Makes sure the built artifacts exist before any test reads them.
 *
 * Builds on demand rather than skipping: in CI `pnpm test` runs before
 * `pnpm build`, and a suite that quietly passes without the artifact proves
 * nothing. Rebuilds, too, when any input is newer than the oldest artifact,
 * so a local run never tests a stale dist/. Runs once, as vitest's global
 * setup (vitest.config.ts): several files need the build, and each building
 * it on its own raced — one `tsup` cleaned `dist/` while another file was
 * reading it.
 */

import { execFile } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
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

/** Everything the build reads that a developer edits. */
const INPUTS = [
  "src",
  "packages/cli/src",
  "package.json",
  "packages/cli/package.json",
  "tsup.config.ts",
  "tsup.bin.config.ts",
  "packages/cli/tsup.config.ts",
];

async function newestMtime(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.mtimeMs;
  const entries = await readdir(path);
  const times = await Promise.all(entries.map((e) => newestMtime(join(path, e))));
  return Math.max(info.mtimeMs, ...times);
}

async function isStale(): Promise<boolean> {
  try {
    const built = await Promise.all(ARTIFACTS.map((f) => stat(f).then((s) => s.mtimeMs)));
    const inputs = await Promise.all(INPUTS.map((p) => newestMtime(join(ROOT, p))));
    return Math.max(...inputs) > Math.min(...built);
  } catch {
    return true; // an artifact is missing
  }
}

export async function ensureBuilt(): Promise<void> {
  if (await isStale()) {
    await run("pnpm", ["build"], { cwd: ROOT });
  }
  await Promise.all(ARTIFACTS.map((f) => access(f)));
}

/** vitest `globalSetup` entry point. */
export default async function setup(): Promise<void> {
  await ensureBuilt();
}
