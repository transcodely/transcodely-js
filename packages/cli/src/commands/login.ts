/**
 * `transcodely login` / `transcodely logout`.
 *
 * The key can arrive three ways: `--api-key`, stdin (`echo $KEY | transcodely
 * login`), or an interactive prompt. It is then proved against the API with
 * one cheap authenticated read before anything is written — saving a key that
 * does not work is worse than not saving one.
 */

import { parseArgs } from "node:util";

import { Transcodely } from "@transcodely/sdk";

import type { Ctx } from "../context.js";
import { EXIT_OK, UsageError } from "../errors.js";
import { printer } from "../output.js";

const OPTIONS = {
  "api-key": { type: "string" },
  app: { type: "string" },
  "base-url": { type: "string" },
  json: { type: "boolean" },
} as const;

export async function loginCommand(ctx: Ctx, argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const flags = parsed.values;
  const out = printer(ctx, flags.json ?? false);

  const apiKey = (flags["api-key"] ?? (await readKey(ctx))).trim();
  if (!apiKey) throw new UsageError("no API key given");
  if (!apiKey.startsWith("ak_")) {
    throw new UsageError(`an API key starts with "ak_" — create one in the dashboard`);
  }
  if (flags.app !== undefined && !flags.app.startsWith("app_")) {
    throw new UsageError(`--app wants an app id starting with "app_", got "${flags.app}"`);
  }

  // Only an explicit --base-url is persisted. Inheriting an ambient
  // TRANSCODELY_BASE_URL would turn a one-off staging shell into sticky config
  // the user can no longer see.
  const baseUrl = flags["base-url"];
  const effectiveBaseUrl = baseUrl ?? ctx.env.TRANSCODELY_BASE_URL;
  const client = new Transcodely({ apiKey, ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}) });
  // One authenticated read. Anything the API answers other than success is
  // surfaced by the caller as an API error, exit 1.
  await client.jobs.list({ pagination: { limit: 1 } });

  const existing = await ctx.store.read();
  await ctx.store.write({
    ...existing,
    apiKey,
    ...(flags.app !== undefined ? { appId: flags.app } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });

  out.result({ saved: true, store: ctx.store.label, app_id: flags.app ?? existing.appId ?? null });
  out.line(`Saved. The key lives in ${ctx.store.label}.`);
  if (flags.app) out.line(`Default app: ${flags.app}`);
  return EXIT_OK;
}

export async function logoutCommand(ctx: Ctx, argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { json: { type: "boolean" } },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const out = printer(ctx, parsed.values.json ?? false);
  await ctx.store.clear();
  out.result({ cleared: true, store: ctx.store.label });
  out.line(`Cleared the saved key from ${ctx.store.label}.`);
  if (ctx.env.TRANSCODELY_API_KEY) {
    out.note("TRANSCODELY_API_KEY is still set in this environment and still takes effect.");
  }
  return EXIT_OK;
}

async function readKey(ctx: Ctx): Promise<string> {
  const piped = await ctx.readStdin();
  if (piped.trim()) return piped;
  if (!ctx.stdinIsTTY) {
    throw new UsageError("pass --api-key, or pipe the key on stdin");
  }
  return await ctx.promptSecret("API key: ");
}
