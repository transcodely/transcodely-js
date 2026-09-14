/**
 * Where the CLI keeps an API key.
 *
 * Order of preference, highest first:
 *   1. `TRANSCODELY_API_KEY` in the environment — always wins, never written.
 *   2. the OS keychain, when one is reachable (`security` on macOS,
 *      `secret-tool` on Linux).
 *   3. `$XDG_CONFIG_HOME/transcodely/config.json` (default `~/.config`),
 *      written 0600 inside a 0700 directory.
 *
 * The whole record is stored as one JSON blob so both backends have the same
 * shape. Secrets never reach a process argument list: `security` is driven
 * through its stdin command mode and `secret-tool` reads the value from stdin
 * by design, so neither shows up in `ps`.
 */

import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export interface StoredCredentials {
  apiKey?: string;
  /** Default app for commands that need one (uploads, URL ingest). */
  appId?: string;
  /** Non-production API base, for staging or a local stack. */
  baseUrl?: string;
}

export interface CredentialStore {
  /** Human-readable name for the place this store writes to. */
  readonly label: string;
  read(): Promise<StoredCredentials>;
  write(next: StoredCredentials): Promise<void>;
  clear(): Promise<void>;
}

const SERVICE = "transcodely";
const ACCOUNT = "cli";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Ceiling on a keychain helper. `security find-generic-password` blocks on a
 * GUI unlock prompt when the keychain is locked, and `secret-tool lookup`
 * blocks on a D-Bus reply when no Secret Service is running — either would
 * wedge the CLI with no output at all. A timeout is read as "this backend is
 * not available", which is exactly what it means.
 */
export const COMMAND_TIMEOUT_MS = 5_000;

/** Runs a command, feeding `input` on stdin. Never throws on a non-zero exit. */
export function runCommand(cmd: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve({ code: 127, stdout: "", stderr: "spawn failed" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (res: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: 124, stdout, stderr: `${cmd} timed out after ${String(COMMAND_TIMEOUT_MS)}ms` });
    }, COMMAND_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", () => finish({ code: 127, stdout, stderr }));
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
}

/**
 * L7: a helper's stderr goes into the message we show, and `security` echoing
 * its own input would put the (trivially decodable) blob on the user's screen.
 * One short line, and nothing that looks like the blob.
 */
function safeStderr(stderr: string): string {
  const line = stderr.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "no detail";
  const clipped = line.length > 120 ? `${line.slice(0, 117)}...` : line;
  return /[A-Za-z0-9+/]{24,}={0,2}/.test(clipped) ? "(detail withheld: it echoed the stored value)" : clipped;
}

export type CommandRunner = typeof runCommand;

/**
 * Keychain values are base64 of the JSON. Base64 has no quotes or spaces, so
 * the blob survives `security -i`'s own argument tokenizer untouched — which
 * is what lets the secret travel on stdin instead of argv.
 */
export function encodeBlob(value: StoredCredentials): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeBlob(encoded: string): StoredCredentials {
  return parse(Buffer.from(encoded, "base64").toString("utf8"));
}

function parse(blob: string): StoredCredentials {
  try {
    const parsed: unknown = JSON.parse(blob);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as StoredCredentials;
    }
  } catch {
    /* a corrupted record reads as "nothing stored" */
  }
  return {};
}

/** macOS Keychain, driven through `security -i` so the secret stays off argv. */
export function macKeychainStore(run: CommandRunner = runCommand): CredentialStore {
  return {
    label: "the macOS keychain",
    async read() {
      const res = await run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
      return res.code === 0 ? decodeBlob(res.stdout.trim()) : {};
    },
    async write(next) {
      const res = await run(
        "security",
        ["-i"],
        `add-generic-password -s ${SERVICE} -a ${ACCOUNT} -U -w ${encodeBlob(next)}\n`,
      );
      if (res.code !== 0) {
        throw new Error(`could not write to the macOS keychain: ${safeStderr(res.stderr)}`);
      }
    },
    async clear() {
      await run("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
    },
  };
}

/** freedesktop Secret Service, via `secret-tool`. */
export function secretToolStore(run: CommandRunner = runCommand): CredentialStore {
  const attrs = ["service", SERVICE, "account", ACCOUNT];
  return {
    label: "the system keyring",
    async read() {
      const res = await run("secret-tool", ["lookup", ...attrs]);
      return res.code === 0 ? decodeBlob(res.stdout.trim()) : {};
    },
    async write(next) {
      const res = await run(
        "secret-tool",
        ["store", "--label=Transcodely CLI", ...attrs],
        encodeBlob(next),
      );
      if (res.code !== 0) {
        throw new Error(`could not write to the system keyring: ${safeStderr(res.stderr)}`);
      }
    },
    async clear() {
      await run("secret-tool", ["clear", ...attrs]);
    },
  };
}

/** Plain file fallback: 0600 inside a 0700 directory. */
export function fileStore(path: string): CredentialStore {
  return {
    label: path,
    async read() {
      try {
        return parse(await readFile(path, "utf8"));
      } catch {
        return {};
      }
    },
    async write(next) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      // writeFile's mode only applies on create; enforce it on an existing file.
      await chmod(path, 0o600);
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}

/**
 * A keychain store that degrades to the 0600 file rather than dead-ending.
 *
 * `secret-tool` installed with no daemon running is a real and common shape on
 * headless Linux: `lookup` fails open to "nothing stored" while `store` fails
 * hard, so without this `login` has no way to succeed unless the user already
 * knows about TRANSCODELY_CONFIG_STORE. Reads prefer the keychain and fall back
 * to whatever the file holds, so a record written either way is found.
 */
export function withFileFallback(
  keychain: CredentialStore,
  file: CredentialStore,
  notify: (message: string) => void,
): CredentialStore {
  let usingFile = false;
  return {
    get label() {
      return usingFile ? file.label : keychain.label;
    },
    async read() {
      const fromKeychain = await keychain.read().catch(() => ({}) as StoredCredentials);
      if (fromKeychain.apiKey) return fromKeychain;
      const fromFile = await file.read();
      if (fromFile.apiKey) usingFile = true;
      return fromFile;
    },
    async write(next) {
      try {
        await keychain.write(next);
        usingFile = false;
      } catch (err) {
        usingFile = true;
        notify(
          `${err instanceof Error ? err.message : String(err)} — saving to ${file.label} instead.`,
        );
        await file.write(next);
      }
    },
    async clear() {
      await keychain.clear().catch(() => undefined);
      await file.clear();
    },
  };
}

export function configPath(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config");
  return join(base, "transcodely", "config.json");
}

/**
 * Picks a backend. `TRANSCODELY_CONFIG_STORE=file` forces the plain file,
 * which is what you want in CI and what the tests use.
 */
export async function defaultStore(
  env: NodeJS.ProcessEnv,
  run: CommandRunner = runCommand,
  notify: (message: string) => void = () => undefined,
): Promise<CredentialStore> {
  // The file is always the floor. On Windows it is the only option, and its
  // 0600 is POSIX-only — Node's chmod there just toggles the read-only bit, so
  // the file is protected by the user profile's own ACL and nothing more.
  const file = fileStore(configPath(env));
  if (env.TRANSCODELY_CONFIG_STORE === "file") return file;
  if (platform() === "darwin" && (await hasCommand("security", run))) {
    return withFileFallback(macKeychainStore(run), file, notify);
  }
  if (platform() === "linux" && (await hasCommand("secret-tool", run))) {
    return withFileFallback(secretToolStore(run), file, notify);
  }
  return file;
}

async function hasCommand(cmd: string, run: CommandRunner): Promise<boolean> {
  const which = await run("which", [cmd]);
  return which.code === 0;
}
