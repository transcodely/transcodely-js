import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  COMMAND_TIMEOUT_MS,
  configPath,
  decodeBlob,
  defaultStore,
  encodeBlob,
  fileStore,
  macKeychainStore,
  runCommand,
  secretToolStore,
  withFileFallback,
  type CommandRunner,
} from "../src/credentials.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "transcodely-creds-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Invocation {
  cmd: string;
  args: string[];
  input: string | undefined;
}

function fakeRunner(
  handler: (inv: Invocation) => { code: number; stdout?: string; stderr?: string },
): { run: CommandRunner; seen: Invocation[] } {
  const seen: Invocation[] = [];
  const run: CommandRunner = (cmd, args, input) => {
    const inv = { cmd, args, input };
    seen.push(inv);
    const res = handler(inv);
    return Promise.resolve({ code: res.code, stdout: res.stdout ?? "", stderr: res.stderr ?? "" });
  };
  return { run, seen };
}

describe("blob encoding", () => {
  it("round-trips through base64", () => {
    const value = { apiKey: 'ak_"quoted" key with spaces', appId: "app_x" };
    expect(decodeBlob(encodeBlob(value))).toEqual(value);
  });

  it("produces nothing a shell-ish tokenizer could split", () => {
    expect(encodeBlob({ apiKey: 'ak_a b"c' })).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("reads a corrupted record as empty rather than throwing", () => {
    expect(decodeBlob("not base64 json!!")).toEqual({});
  });
});

describe("file store", () => {
  it("writes 0600 and reads back", async () => {
    const path = join(tmp, "nested", "config.json");
    const store = fileStore(path);
    await store.write({ apiKey: "ak_1", appId: "app_1" });
    expect(await store.read()).toEqual({ apiKey: "ak_1", appId: "app_1" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("re-tightens the mode on an existing loose file", async () => {
    const path = join(tmp, "config.json");
    const store = fileStore(path);
    await store.write({ apiKey: "ak_1" });
    const { chmod } = await import("node:fs/promises");
    await chmod(path, 0o644);
    await store.write({ apiKey: "ak_2" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("reads as empty when the file is absent", async () => {
    expect(await fileStore(join(tmp, "nope.json")).read()).toEqual({});
  });

  it("clear removes the file and is safe when it is already gone", async () => {
    const path = join(tmp, "config.json");
    const store = fileStore(path);
    await store.write({ apiKey: "ak_1" });
    await store.clear();
    await store.clear();
    expect(await store.read()).toEqual({});
  });
});

describe("macOS keychain store", () => {
  it("never puts the secret on the argument list", async () => {
    const { run, seen } = fakeRunner(() => ({ code: 0 }));
    await macKeychainStore(run).write({ apiKey: "ak_supersecret" });
    const write = seen[0]!;
    expect(write.cmd).toBe("security");
    expect(write.args).toEqual(["-i"]);
    expect(write.args.join(" ")).not.toContain("ak_supersecret");
    expect(write.input).toContain("add-generic-password");
    expect(decodeBlob(write.input!.split(" -w ")[1]!.trim())).toEqual({ apiKey: "ak_supersecret" });
  });

  it("reads what it wrote", async () => {
    let stored = "";
    const { run } = fakeRunner((inv) => {
      if (inv.args[0] === "-i") {
        stored = inv.input!.split(" -w ")[1]!.trim();
        return { code: 0 };
      }
      return { code: 0, stdout: `${stored}\n` };
    });
    const store = macKeychainStore(run);
    await store.write({ apiKey: "ak_1", appId: "app_1" });
    expect(await store.read()).toEqual({ apiKey: "ak_1", appId: "app_1" });
  });

  it("reads as empty when there is no keychain item", async () => {
    const { run } = fakeRunner(() => ({ code: 44, stderr: "could not be found" }));
    expect(await macKeychainStore(run).read()).toEqual({});
  });

  it("surfaces a write failure instead of pretending it saved", async () => {
    const { run } = fakeRunner(() => ({ code: 1, stderr: "User interaction is not allowed." }));
    await expect(macKeychainStore(run).write({ apiKey: "ak_1" })).rejects.toThrow(/keychain/);
  });
});

describe("secret-tool store", () => {
  it("feeds the secret on stdin, not argv", async () => {
    const { run, seen } = fakeRunner(() => ({ code: 0 }));
    await secretToolStore(run).write({ apiKey: "ak_supersecret" });
    expect(seen[0]!.cmd).toBe("secret-tool");
    expect(seen[0]!.args).toContain("store");
    expect(seen[0]!.args.join(" ")).not.toContain("ak_supersecret");
    expect(decodeBlob(seen[0]!.input!)).toEqual({ apiKey: "ak_supersecret" });
  });

  it("surfaces a write failure", async () => {
    const { run } = fakeRunner(() => ({ code: 1, stderr: "no keyring daemon" }));
    await expect(secretToolStore(run).write({ apiKey: "ak_1" })).rejects.toThrow(/keyring/);
  });
});

describe("a keychain that will not cooperate", () => {
  it("falls back to the 0600 file when the keychain write fails, and says so", async () => {
    const notes: string[] = [];
    const path = join(tmp, "config.json");
    const broken = secretToolStore(
      fakeRunner(() => ({ code: 1, stderr: "Cannot autolaunch D-Bus without X11" })).run,
    );
    const store = withFileFallback(broken, fileStore(path), (m) => notes.push(m));

    await store.write({ apiKey: "ak_1", appId: "app_1" });

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("D-Bus");
    expect(notes[0]).toContain(path);
    expect(await store.read()).toEqual({ apiKey: "ak_1", appId: "app_1" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(store.label).toBe(path);
  });

  it("prefers the keychain when it works and never touches the file", async () => {
    let stored = "";
    const { run } = fakeRunner((inv) => {
      if (inv.args[0] === "store") {
        stored = inv.input!;
        return { code: 0 };
      }
      return { code: 0, stdout: `${stored}\n` };
    });
    const path = join(tmp, "config.json");
    const store = withFileFallback(secretToolStore(run), fileStore(path), () => {
      throw new Error("should not have fallen back");
    });
    await store.write({ apiKey: "ak_1" });
    expect(await store.read()).toEqual({ apiKey: "ak_1" });
    await expect(stat(path)).rejects.toThrow();
  });

  it("clears both backends, so a fallback record cannot survive a logout", async () => {
    const path = join(tmp, "config.json");
    const file = fileStore(path);
    await file.write({ apiKey: "ak_leftover" });
    const store = withFileFallback(
      secretToolStore(fakeRunner(() => ({ code: 1 })).run),
      file,
      () => undefined,
    );
    await store.clear();
    expect(await file.read()).toEqual({});
  });

  it("kills a helper that never answers instead of hanging the CLI", async () => {
    const started = Date.now();
    // `sleep` outlives the ceiling; the runner must return on its own.
    const res = await runCommand("sleep", ["30"]);
    expect(res.code).toBe(124);
    expect(res.stderr).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(COMMAND_TIMEOUT_MS + 4000);
  }, 20_000);
});

describe("redaction", () => {
  it("never echoes a stored blob back through an error message", async () => {
    const blob = encodeBlob({ apiKey: "ak_supersecret_value_here" });
    const { run } = fakeRunner(() => ({
      code: 1,
      stderr: `security: could not write "${blob}" to the keychain`,
    }));
    await expect(macKeychainStore(run).write({ apiKey: "ak_supersecret_value_here" })).rejects.toThrow(
      /detail withheld/,
    );
  });

  it("keeps a short, blob-free detail", async () => {
    const { run } = fakeRunner(() => ({ code: 1, stderr: "User interaction is not allowed." }));
    await expect(macKeychainStore(run).write({ apiKey: "ak_1" })).rejects.toThrow(
      /User interaction is not allowed/,
    );
  });
});

describe("store selection", () => {
  it("TRANSCODELY_CONFIG_STORE=file skips the keychain probe entirely", async () => {
    const { run, seen } = fakeRunner(() => ({ code: 0 }));
    const store = await defaultStore(
      { TRANSCODELY_CONFIG_STORE: "file", XDG_CONFIG_HOME: tmp } as NodeJS.ProcessEnv,
      run,
    );
    expect(seen).toHaveLength(0);
    expect(store.label).toBe(join(tmp, "transcodely", "config.json"));
  });

  it("falls back to the file when no keychain tool is on PATH", async () => {
    const { run } = fakeRunner(() => ({ code: 1 }));
    const store = await defaultStore({ XDG_CONFIG_HOME: tmp } as NodeJS.ProcessEnv, run);
    expect(store.label).toBe(join(tmp, "transcodely", "config.json"));
  });

  it("wraps a present keychain tool in the file fallback rather than trusting it", async () => {
    // `which` succeeds, the helper then fails on write — which must still leave
    // the user logged in, via the file.
    const { run } = fakeRunner((inv) => (inv.cmd === "which" ? { code: 0 } : { code: 1 }));
    const notes: string[] = [];
    const store = await defaultStore({ XDG_CONFIG_HOME: tmp } as NodeJS.ProcessEnv, run, (m) =>
      notes.push(m),
    );
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    await store.write({ apiKey: "ak_1" });
    expect(notes).toHaveLength(1);
    expect(await store.read()).toEqual({ apiKey: "ak_1" });
  });

  it("honours XDG_CONFIG_HOME, then HOME", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x" } as NodeJS.ProcessEnv)).toBe(
      "/x/transcodely/config.json",
    );
    expect(configPath({ HOME: "/home/dev" } as NodeJS.ProcessEnv)).toBe(
      "/home/dev/.config/transcodely/config.json",
    );
  });
});
