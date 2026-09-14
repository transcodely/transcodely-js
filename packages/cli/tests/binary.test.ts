/**
 * The same commands, driven through the built `dist/index.mjs` in a real child
 * process.
 *
 * The in-process suite exercises `run()`; this one exercises everything between
 * the shell and `run()` — the shebang, the entry point's argv slicing, the
 * stdin drain, and the exit code actually reaching the shell. H2 (a flag before
 * the positional) was invisible to the in-process tests until the CLI was
 * driven this way, so these stay.
 */

import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startMockApi, VIDEO_ID, type MockApi } from "./mock-api.js";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BIN = join(ROOT, "packages", "cli", "dist", "index.mjs");
// The CLI keeps @transcodely/sdk external, so the workspace link resolves to
// the SDK's own dist at runtime. Both artifacts have to exist, not just the bin.
const SDK = join(ROOT, "dist", "index.mjs");

let tmp: string;
let api: MockApi | undefined;

beforeAll(async () => {
  // Build on demand rather than skipping. A suite that quietly passes when the
  // artifact is missing proves nothing, and in CI `pnpm test` runs before
  // `pnpm build` — which is exactly when these assertions matter most.
  const present = await Promise.all([BIN, SDK].map((f) => access(f).then(() => true, () => false)));
  if (present.includes(false)) {
    await run("pnpm", ["build"], { cwd: ROOT });
  }
  await access(BIN);
  await access(SDK);
}, 180_000);

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "transcodely-bin-"));
});

afterEach(async () => {
  await api?.close();
  api = undefined;
  await rm(tmp, { recursive: true, force: true });
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function bin(args: string[], env: Record<string, string> = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: tmp,
        XDG_CONFIG_HOME: join(tmp, "config"),
        TRANSCODELY_CONFIG_STORE: "file",
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("the built binary", () => {
  it("prints help and exits 0", async () => {
    const res = await bin(["--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("USAGE");
  });

  it.each([
    ["flag after the input", (url: string) => [url, "--json"]],
    ["flag before the input", (url: string) => ["--json", url]],
  ])("accepts a URL with the %s", async (_name, build) => {
    api = await startMockApi();
    const res = await bin(build("https://example.com/talk.mp4"), {
      TRANSCODELY_API_KEY: "ak_test",
      TRANSCODELY_APP_ID: "app_k1l2m3n4o5",
      TRANSCODELY_BASE_URL: api.baseUrl,
    });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).id).toBe(VIDEO_ID);
  });

  it("accepts --api-key before a file path, the README's own form", async () => {
    api = await startMockApi();
    const path = join(tmp, "clip.mp4");
    await writeFile(path, Buffer.alloc(2048, 3));
    const res = await bin(["--api-key", "ak_from_flag", "--app", "app_k1l2m3n4o5", path], {
      TRANSCODELY_BASE_URL: api.baseUrl,
    });
    expect(res.code).toBe(0);
    expect(api.calls[0]!.authorization).toBe("Bearer ak_from_flag");
    expect(api.puts).toHaveLength(1);
  });

  it("uploads a file titled `help` instead of printing the help page (H4)", async () => {
    api = await startMockApi();
    const path = join(tmp, "clip.mp4");
    await writeFile(path, Buffer.alloc(2048, 3));
    const res = await bin([path, "--title", "help"], {
      TRANSCODELY_API_KEY: "ak_test",
      TRANSCODELY_APP_ID: "app_k1l2m3n4o5",
      TRANSCODELY_BASE_URL: api.baseUrl,
    });
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain("USAGE");
    expect(api.puts).toHaveLength(1);
    expect(api.calls[0]!.body.title).toBe("help");
  });

  it("refuses a dash-leading flag value as ambiguous rather than answering it", async () => {
    api = await startMockApi();
    const res = await bin(["https://example.com/talk.mp4", "--title", "-h"], {
      TRANSCODELY_API_KEY: "ak_test",
      TRANSCODELY_APP_ID: "app_k1l2m3n4o5",
      TRANSCODELY_BASE_URL: api.baseUrl,
    });
    expect(res.code).toBe(2);
    expect(res.stdout).not.toContain("USAGE");
    expect(api.calls).toHaveLength(0);
  });

  it("still prints help for a --help anywhere on the line", async () => {
    const withPositional = await bin(["./x.mp4", "--help"]);
    expect(withPositional.code).toBe(0);
    expect(withPositional.stdout).toContain("USAGE");
  });

  it("exits 2 on a genuinely unknown option", async () => {
    const res = await bin(["--definitely-not-a-flag", "x.mp4"], {
      TRANSCODELY_API_KEY: "ak_test",
    });
    expect(res.code).toBe(2);
    expect(res.stderr.toLowerCase()).toContain("unknown option");
  });

  it("exits 1 with the API's code when the API refuses", async () => {
    api = await startMockApi({
      errors: {
        CreateFromUrl: { status: 402, code: "billing_past_due", message: "unpaid invoice" },
      },
    });
    const res = await bin(["https://example.com/talk.mp4"], {
      TRANSCODELY_API_KEY: "ak_test",
      TRANSCODELY_APP_ID: "app_k1l2m3n4o5",
      TRANSCODELY_BASE_URL: api.baseUrl,
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("billing_past_due");
  });

  it("reads a piped API key for login and saves it under XDG_CONFIG_HOME", async () => {
    api = await startMockApi();
    const { stdout } = await run(
      "/bin/sh",
      [
        "-c",
        `printf 'ak_piped_key' | "${process.execPath}" "${BIN}" login --app app_k1l2m3n4o5`,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: tmp,
          XDG_CONFIG_HOME: join(tmp, "config"),
          TRANSCODELY_CONFIG_STORE: "file",
          TRANSCODELY_BASE_URL: api.baseUrl,
        },
      },
    );
    expect(stdout).toContain("Saved.");
    expect(api.calls.find((c) => c.method === "List")!.authorization).toBe("Bearer ak_piped_key");
  });
});
