/**
 * `npx @transcodely/sdk <command>`, as close to the real install as a test
 * can get without the registry.
 *
 * The tarball is the one `npm publish` would upload (`npm pack`), unpacked into
 * a fresh `node_modules/@transcodely/sdk` with only its one runtime dependency
 * beside it — no workspace links. That is what proves the bin resolves
 * `@transcodely/sdk` to the installed package itself (Node's package
 * self-reference through the `exports` map) rather than to the repo's sources.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { startMockApi, VIDEO_ID, type MockApi } from "../../packages/cli/tests/mock-api.js";
// dist/ is built, when missing, by the global setup in tests/package/build.ts.
import { ROOT, run } from "./build.js";

const exec = promisify(execFile);

interface PackResult {
  filename: string;
  files: { path: string }[];
}

let tmp: string;
let pack: PackResult;
let bin: string;
let api: MockApi | undefined;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "transcodely-sdk-bin-"));
  // --ignore-scripts: `prepare` is husky, which would rewrite this checkout's
  // git hook config. Publishing runs from CI, where that is harmless.
  const { stdout } = await run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", tmp],
    { cwd: ROOT },
  );
  pack = (JSON.parse(stdout) as PackResult[])[0]!;

  const pkgDir = join(tmp, "app", "node_modules", "@transcodely", "sdk");
  await mkdir(pkgDir, { recursive: true });
  await exec("tar", ["-xzf", join(tmp, pack.filename), "-C", pkgDir, "--strip-components=1"]);
  // The tarball's only runtime dependency, from this repo's install.
  await mkdir(join(tmp, "app", "node_modules", "@bufbuild"), { recursive: true });
  await symlink(
    realpathSync(join(ROOT, "node_modules", "@bufbuild", "protobuf")),
    join(tmp, "app", "node_modules", "@bufbuild", "protobuf"),
  );

  const manifest = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as {
    bin: Record<string, string>;
  };
  bin = join(pkgDir, manifest.bin.transcodely!);
}, 240_000);

afterEach(async () => {
  await api?.close();
  api = undefined;
});

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function npxSdk(args: string[], env: Record<string, string> = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [bin, ...args], {
      cwd: join(tmp, "app"),
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

describe("the packed @transcodely/sdk tarball", () => {
  it("ships the bin, executable, with a shebang", async () => {
    const paths = pack.files.map((f) => f.path);
    expect(paths).toContain("dist/bin/transcodely.mjs");
    expect((await readFile(bin, "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("ships nothing that looks like a secret or local config", () => {
    const suspicious = pack.files
      .map((f) => f.path)
      .filter((p) => /(^|\/)\.env|\.npmrc$|\.pem$|\.key$|credentials\.json$/i.test(p));
    expect(suspicious).toEqual([]);
  });

  it("ships no CLI sources or tests, only the built bin", () => {
    const fromCli = pack.files.map((f) => f.path).filter((p) => p.startsWith("packages/"));
    expect(fromCli).toEqual([]);
  });
});

describe("npx @transcodely/sdk", () => {
  it("prints help and exits 0", async () => {
    const res = await npxSdk(["--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("USAGE");
    expect(res.stdout).toContain("npx @transcodely/sdk upload");
  });

  it("uploads a file with `upload` against the API", async () => {
    api = await startMockApi();
    const path = join(tmp, "video.mp4");
    await writeFile(path, Buffer.alloc(4096, 5));
    const res = await npxSdk(["upload", path, "--json"], {
      TRANSCODELY_API_KEY: "ak_test",
      TRANSCODELY_APP_ID: "app_k1l2m3n4o5",
      TRANSCODELY_BASE_URL: api.baseUrl,
    });
    expect(res.stderr).toBe("");
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).id).toBe(VIDEO_ID);
    expect(api.calls.map((c) => c.method)).toEqual(["CreateUpload", "CompleteUpload"]);
    expect(api.calls[0]!.authorization).toBe("Bearer ak_test");
    expect(api.puts).toEqual([{ url: "/s3/single", size: 4096 }]);
  });

  it("reports an API refusal with its code and exits 1", async () => {
    // The error is raised inside the installed library and classified by the
    // bin's `instanceof TranscodelyError`, so this checks the two meet as one
    // module: had the bin resolved a different copy, the code would be lost to
    // the generic branch.
    api = await startMockApi({
      errors: {
        CreateFromUrl: { status: 402, code: "billing_past_due", message: "unpaid invoice" },
      },
    });
    const res = await npxSdk(["upload", "https://example.com/talk.mp4"], {
      TRANSCODELY_API_KEY: "ak_test",
      TRANSCODELY_APP_ID: "app_k1l2m3n4o5",
      TRANSCODELY_BASE_URL: api.baseUrl,
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("billing_past_due: unpaid invoice");
  });
});
