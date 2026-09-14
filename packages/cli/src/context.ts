/**
 * Everything the CLI touches outside its own code, in one injectable bag.
 * `index.ts` fills it from the real process; the tests fill it with captures
 * and a mock server, which is why every command is testable in-process.
 */

import { Transcodely } from "@transcodely/sdk";

import type { CredentialStore, StoredCredentials } from "./credentials.js";
import { UsageError } from "./errors.js";

export interface Ctx {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdout(text: string): void;
  stderr(text: string): void;
  /** True when stdout is a terminal — gates progress redraws, never content. */
  isTTY: boolean;
  /**
   * True when *stdin* is a terminal. Separate from `isTTY` on purpose:
   * `transcodely login > out.txt` has a piped stdout and a perfectly usable
   * stdin, and branching on the wrong one refused that.
   */
  stdinIsTTY: boolean;
  readStdin(): Promise<string>;
  /** Reads a secret without echoing it. Injected so tests never need a pty. */
  promptSecret(prompt: string): Promise<string>;
  store: CredentialStore;
}

export interface Session {
  client: Transcodely;
  /** App the key is scoped to, when we know it. */
  appId: string | undefined;
  apiKey: string;
}

/**
 * Resolves the API key: `--api-key`, then `TRANSCODELY_API_KEY`, then whatever
 * `transcodely login` stored. The environment deliberately outranks the store
 * so CI can override a developer's saved key without logging out.
 */
export async function openSession(
  ctx: Ctx,
  flags: { apiKey?: string; app?: string; baseUrl?: string } = {},
): Promise<Session> {
  const stored: StoredCredentials = await ctx.store.read();
  const apiKey = flags.apiKey ?? ctx.env.TRANSCODELY_API_KEY ?? stored.apiKey;
  if (!apiKey) {
    throw new UsageError(
      "no API key — run `transcodely login`, or set TRANSCODELY_API_KEY, or pass --api-key",
    );
  }
  const baseUrl = flags.baseUrl ?? ctx.env.TRANSCODELY_BASE_URL ?? stored.baseUrl;
  const client = new Transcodely({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  });
  return {
    client,
    apiKey,
    appId: flags.app ?? ctx.env.TRANSCODELY_APP_ID ?? stored.appId,
  };
}

/** The app id for a call that cannot do without one. */
export function requireApp(session: Session): string {
  if (!session.appId) {
    throw new UsageError(
      "this command needs an app — pass --app app_…, set TRANSCODELY_APP_ID, or save one with `transcodely login --app app_…`",
    );
  }
  return session.appId;
}
