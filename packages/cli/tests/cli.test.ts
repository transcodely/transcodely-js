import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ImportSourceType, JobStatus, VideoStatus } from "@transcodely/sdk";

import { TERMINAL_JOB, TERMINAL_VIDEO } from "../src/commands/upload.js";
import { fileStore, type CredentialStore } from "../src/credentials.js";
import { run } from "../src/main.js";
import { CLI_VERSION } from "../src/version.js";
import { SOURCE_TYPE_URLS, parseImportCsv } from "../src/commands/import.js";
import {
  IMPORT_ID,
  JOB_ID,
  VIDEO_ID,
  jobJson,
  startMockApi,
  type MockApi,
  type MockApiOptions,
} from "./mock-api.js";

let tmp: string;
let api: MockApi | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "transcodely-cli-"));
});

afterEach(async () => {
  await api?.close();
  api = undefined;
  await rm(tmp, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOpts {
  env?: Record<string, string | undefined>;
  stdin?: string;
  isTTY?: boolean;
  stdinIsTTY?: boolean;
  /** Stands in for the real muted terminal prompt. */
  promptSecret?: () => Promise<string>;
  store?: CredentialStore;
}

async function cli(argv: string[], opts: RunOpts = {}): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await run({
    argv,
    env: { ...opts.env } as NodeJS.ProcessEnv,
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    isTTY: opts.isTTY ?? false,
    stdinIsTTY: opts.stdinIsTTY ?? false,
    readStdin: () => Promise.resolve(opts.stdin ?? ""),
    promptSecret:
      opts.promptSecret ??
      (() => Promise.reject(new Error("promptSecret called unexpectedly"))),
    store: opts.store ?? fileStore(join(tmp, "config.json")),
  });
  return { code, stdout, stderr };
}

async function withApi(options: MockApiOptions = {}): Promise<Record<string, string>> {
  api = await startMockApi(options);
  return {
    TRANSCODELY_API_KEY: "ak_test_key",
    TRANSCODELY_APP_ID: "app_k1l2m3n4o5",
    TRANSCODELY_BASE_URL: api.baseUrl,
  };
}

async function fixture(name: string, size: number): Promise<string> {
  const path = join(tmp, name);
  await writeFile(path, Buffer.alloc(size, 7));
  return path;
}

describe("help and version", () => {
  it("prints help with no arguments and exits 0", async () => {
    const res = await cli([]);
    expect(res.code).toBe(0);
    // release-please rewrites CLI_VERSION on every release; the snapshot
    // pins the help text, not the version, so replace it before comparing.
    expect(res.stdout.replaceAll(CLI_VERSION, "<version>")).toMatchSnapshot();
  });

  it("prints the same help for --help", async () => {
    const bare = await cli([]);
    const flagged = await cli(["--help"]);
    expect(flagged.stdout).toBe(bare.stdout);
    expect(flagged.code).toBe(0);
  });

  it("prints just the version for --version", async () => {
    const res = await cli(["--version"]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exits 2 on a genuinely unknown option", async () => {
    const res = await cli(["--nope", "./whatever.mp4"]);
    expect(res.code).toBe(2);
    expect(res.stderr.toLowerCase()).toContain("unknown option");
  });
});

describe("the video terminal set", () => {
  // The --wait tests keep emitting past the terminal frame, which catches a set
  // that is too NARROW. They cannot catch one that is too WIDE: a status the
  // server never sends is inert. So the set is pinned against its source —
  // api internal/domain/video.go, `func (v *Video) IsTerminal`, which is
  // VideoStatusReady | VideoStatusError | VideoStatusDeleted. "failed" is a job
  // word and is not a video status at all.
  it("is exactly ready | error | deleted", () => {
    expect([...TERMINAL_VIDEO].sort()).toEqual(["deleted", "error", "ready"]);
  });

  it("names only real VideoStatus values", () => {
    // The set holds wire strings, so a typo would be inert rather than a type
    // error — check each one against the enum the API actually sends.
    const wire = Object.keys(VideoStatus)
      .filter((k) => Number.isNaN(Number(k)))
      .map((k) => k.toLowerCase());
    for (const status of TERMINAL_VIDEO) expect(wire).toContain(status);
  });
});

describe("the job terminal set", () => {
  // Same hazard as the video set, one level up: JobStatus gained PARTIAL and
  // AWAITING_CONFIRMATION after the first SDK release. A new status must be
  // classified, so the two sets are asserted to partition the enum — adding
  // one upstream fails here until someone decides whether --wait stops on it.
  const NON_TERMINAL = [
    JobStatus.UNSPECIFIED,
    JobStatus.PENDING,
    JobStatus.PROBING,
    JobStatus.PROCESSING,
    JobStatus.AWAITING_CONFIRMATION,
  ];

  it("together with the non-terminal statuses covers every JobStatus exactly once", () => {
    const all = Object.values(JobStatus).filter((v): v is JobStatus => typeof v === "number");
    const classified = [...TERMINAL_JOB, ...NON_TERMINAL].sort((a, b) => a - b);
    expect(classified).toEqual([...all].sort((a, b) => a - b));
  });

  it("does not stop on a job still awaiting confirmation", () => {
    // A delayed-start job parks in AWAITING_CONFIRMATION until the caller
    // confirms it; treating that as terminal would report an unfinished job
    // as a finished one.
    expect(TERMINAL_JOB.has(JobStatus.AWAITING_CONFIRMATION)).toBe(false);
  });
});

describe("`help` and `version` as flag VALUES, not requests for help (H4)", () => {
  // Scanning the argv could not tell an option from an option's value, so
  // `--title help` printed the help page and exited 0 without uploading — a
  // silent no-op reported as success. These are the tests that catch that.
  it.each([
    ["--title", "help"],
    ["--title", "version"],
    ["--visibility", "help"],
  ])("a URL ingest with %s %s still reaches the API", async (flag, value) => {
    const env = await withApi();
    const res = await cli(["https://example.com/talk.mp4", flag, value], { env });
    expect(res.code).toBe(0);
    expect(api!.calls.map((c) => c.method)).toEqual(["CreateFromUrl"]);
    expect(res.stdout).not.toContain("USAGE");
  });

  it("an upload titled `help` is actually uploaded", async () => {
    const env = await withApi();
    const path = await fixture("clip.mp4", 2048);
    const res = await cli([path, "--title", "help"], { env });
    expect(res.code).toBe(0);
    expect(api!.puts).toHaveLength(1);
    expect(api!.calls[0]!.body.title).toBe("help");
  });

  it("a preset named `version` does not print the version", async () => {
    const env = await withApi();
    const res = await cli(["https://example.com/talk.mp4", "--preset", "version"], { env });
    expect(res.code).toBe(0);
    expect(res.stdout).not.toMatch(/^\d+\.\d+\.\d+\s*$/);
    expect(api!.calls[0]!.body.preset).toBe("version");
  });

  it.each([
    ["--title", "-h"],
    ["--visibility", "-v"],
  ])("refuses %s %s as ambiguous instead of answering it", async (flag, value) => {
    const env = await withApi();
    const res = await cli(["https://example.com/talk.mp4", flag, value], { env });
    expect(res.code).toBe(2);
    expect(res.stdout).not.toContain("USAGE");
    expect(res.stderr).toContain("ambiguous");
    expect(api!.calls).toHaveLength(0);
  });

  it("takes a dash-leading value through the documented `=` escape", async () => {
    const env = await withApi();
    const res = await cli(["https://example.com/talk.mp4", "--title=-h"], { env });
    expect(res.code).toBe(0);
    expect(api!.calls[0]!.body.title).toBe("-h");
  });

  it.each([
    [["--help"]],
    [["-h"]],
    [["./whatever.mp4", "--help"]],
    [["https://example.com/talk.mp4", "--help"]],
    [["jobs", "--help"]],
    [["jobs", "ls", "--help"]],
    [["videos", "--help"]],
    [["login", "--help"]],
    [["logout", "--help"]],
    [["help"]],
  ])("%j still prints help, exits 0 and calls nothing", async (argv) => {
    const env = await withApi();
    const res = await cli(argv, { env });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("USAGE");
    expect(api!.calls).toHaveLength(0);
  });

  it.each([[["--version"]], [["-v"]], [["version"]], [["jobs", "ls", "--version"]]])(
    "%j still prints just the version",
    async (argv) => {
      const env = await withApi();
      const res = await cli(argv, { env });
      expect(res.code).toBe(0);
      expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
      expect(api!.calls).toHaveLength(0);
    },
  );
});

describe("flags may appear before the positional (H2)", () => {
  it.each([
    ["after", (url: string) => [url, "--json"]],
    ["before", (url: string) => ["--json", url]],
  ])("accepts --json %s the input", async (_where, build) => {
    const env = await withApi();
    const res = await cli(build("https://example.com/talk.mp4"), { env });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).id).toBe(VIDEO_ID);
  });

  it("accepts --api-key before the input, the form the README documents", async () => {
    api = await startMockApi();
    const res = await cli(
      ["--api-key", "ak_from_flag", "--app", "app_k1l2m3n4o5", "https://example.com/talk.mp4"],
      { env: { TRANSCODELY_BASE_URL: api.baseUrl } },
    );
    expect(res.code).toBe(0);
    expect(api.calls[0]!.authorization).toBe("Bearer ak_from_flag");
  });

  it("accepts a file path with every flag in front of it", async () => {
    const env = await withApi();
    const path = await fixture("clip.mp4", 2048);
    const res = await cli(["--title", "Clip", "--json", path], { env });
    expect(res.code).toBe(0);
    expect(api!.calls[0]!.body.title).toBe("Clip");
  });

  it("still treats a leading subcommand as a subcommand", async () => {
    const env = await withApi();
    const res = await cli(["jobs", "ls", "--json"], { env });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toHaveProperty("jobs");
  });
});

describe("--json on the error path (M4)", () => {
  it("prints one parseable error document and still exits 1", async () => {
    const env = await withApi({
      errors: {
        CreateFromUrl: {
          status: 503,
          code: "hosting_provisioning_failed",
          message: "could not provision managed storage",
        },
      },
    });
    const res = await cli(["https://example.com/talk.mp4", "--json"], { env });
    expect(res.code).toBe(1);
    const parsed: any = JSON.parse(res.stdout);
    expect(parsed.error.code).toBe("hosting_provisioning_failed");
    expect(parsed.error.message).toContain("provision");
  });

  it("prints one parseable error document for a usage error too, and exits 2", async () => {
    const res = await cli(["--json", "https://example.com/a.mp4", "--hls", "--mp4"], {
      env: { TRANSCODELY_API_KEY: "ak_x", TRANSCODELY_APP_ID: "app_k1l2m3n4o5" },
    });
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout).error.code).toBe("usage");
  });

  it("adds a plain-language line for a code it recognises", async () => {
    const env = await withApi({
      errors: {
        CreateFromUrl: {
          status: 402,
          code: "billing_past_due",
          message: "organization has an unpaid invoice",
        },
      },
    });
    const res = await cli(["https://example.com/talk.mp4"], { env });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("unpaid invoice");
    expect(res.stderr).toContain("Settle it in the dashboard");
  });

  it("says nothing extra for a code it does not recognise", async () => {
    const env = await withApi({
      errors: { CreateFromUrl: { status: 500, code: "weird_new_code", message: "boom" } },
    });
    const res = await cli(["https://example.com/talk.mp4"], { env });
    expect(res.stderr).toContain("weird_new_code: boom");
    // No indented hint line follows it — an unrecognised code gets no guess.
    const indented = res.stderr.split("\n").filter((l) => /^\s+\S/.test(l));
    expect(indented).toEqual([]);
  });
});

describe("credentials", () => {
  it("exits 2 with no key anywhere", async () => {
    const res = await cli(["jobs", "ls"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("transcodely login");
  });

  it("login verifies the key against the API and saves it 0600", async () => {
    const env = await withApi();
    const path = join(tmp, "config.json");
    const res = await cli(["login", "--api-key", "ak_live_123", "--app", "app_k1l2m3n4o5"], {
      env: { TRANSCODELY_BASE_URL: env.TRANSCODELY_BASE_URL },
      store: fileStore(path),
    });
    expect(res.code).toBe(0);
    // The verification call really happened, with the new key.
    const probe = api!.calls.find((c) => c.method === "List");
    expect(probe!.authorization).toBe("Bearer ak_live_123");

    const saved: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(saved).toMatchObject({ apiKey: "ak_live_123", appId: "app_k1l2m3n4o5" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("login reads the key from stdin", async () => {
    const env = await withApi();
    const path = join(tmp, "config.json");
    const res = await cli(["login"], {
      env: { TRANSCODELY_BASE_URL: env.TRANSCODELY_BASE_URL },
      stdin: "ak_piped_key\n",
      store: fileStore(path),
    });
    expect(res.code).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ apiKey: "ak_piped_key" });
  });

  it("login refuses something that is not an API key, without calling the API", async () => {
    const env = await withApi();
    const res = await cli(["login", "--api-key", "hunter2"], {
      env: { TRANSCODELY_BASE_URL: env.TRANSCODELY_BASE_URL },
    });
    expect(res.code).toBe(2);
    expect(api!.calls).toHaveLength(0);
  });

  it("login exits 1 and saves nothing when the API rejects the key", async () => {
    const env = await withApi({
      errors: { List: { status: 401, code: "invalid_api_key", message: "no such key" } },
    });
    const path = join(tmp, "config.json");
    const res = await cli(["login", "--api-key", "ak_bad"], {
      env: { TRANSCODELY_BASE_URL: env.TRANSCODELY_BASE_URL },
      store: fileStore(path),
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no such key");
    await expect(stat(path)).rejects.toThrow();
  });

  it("the environment outranks a saved key", async () => {
    const env = await withApi();
    const store = fileStore(join(tmp, "config.json"));
    await store.write({ apiKey: "ak_saved", appId: "app_k1l2m3n4o5" });
    const res = await cli(["jobs", "ls"], { env, store });
    expect(res.code).toBe(0);
    expect(api!.calls[0]!.authorization).toBe("Bearer ak_test_key");
  });

  it("prompts on a terminal stdin even when stdout is redirected", async () => {
    const env = await withApi();
    const path = join(tmp, "config.json");
    const res = await cli(["login"], {
      env: { TRANSCODELY_BASE_URL: env.TRANSCODELY_BASE_URL },
      isTTY: false, // stdout is a pipe…
      stdinIsTTY: true, // …but stdin is the terminal, which is what matters
      promptSecret: () => Promise.resolve("ak_typed_key"),
      store: fileStore(path),
    });
    expect(res.code).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ apiKey: "ak_typed_key" });
  });

  it("refuses rather than prompting when stdin is not a terminal", async () => {
    const env = await withApi();
    const res = await cli(["login"], {
      env: { TRANSCODELY_BASE_URL: env.TRANSCODELY_BASE_URL },
      isTTY: true, // an interactive stdout must not be mistaken for stdin
      stdinIsTTY: false,
    });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("pipe the key on stdin");
  });

  it("does not persist an ambient TRANSCODELY_BASE_URL as sticky config", async () => {
    const env = await withApi();
    const path = join(tmp, "config.json");
    await cli(["login", "--api-key", "ak_live_123"], {
      env: { TRANSCODELY_BASE_URL: env.TRANSCODELY_BASE_URL },
      store: fileStore(path),
    });
    const saved: any = JSON.parse(await readFile(path, "utf8"));
    expect(saved.apiKey).toBe("ak_live_123");
    expect(saved.baseUrl).toBeUndefined();
  });

  it("persists an explicit --base-url", async () => {
    const env = await withApi();
    const path = join(tmp, "config.json");
    await cli(["login", "--api-key", "ak_live_123", "--base-url", env.TRANSCODELY_BASE_URL!], {
      store: fileStore(path),
    });
    expect(JSON.parse(await readFile(path, "utf8")).baseUrl).toBe(env.TRANSCODELY_BASE_URL);
  });

  it("logout clears the store", async () => {
    const store = fileStore(join(tmp, "config.json"));
    await store.write({ apiKey: "ak_saved" });
    const res = await cli(["logout"], { store });
    expect(res.code).toBe(0);
    expect(await store.read()).toEqual({});
  });
});

describe("transcodely <url>", () => {
  it("ingests a URL through CreateFromUrl by default", async () => {
    const env = await withApi();
    const res = await cli(["https://example.com/talk.mp4", "--title", "Talk"], { env });
    expect(res.code).toBe(0);
    const call = api!.calls.find((c) => c.method === "CreateFromUrl")!;
    expect(call.body).toMatchObject({
      app_id: "app_k1l2m3n4o5",
      url: "https://example.com/talk.mp4",
      title: "Talk",
    });
    expect(res.stdout).toContain(VIDEO_ID);
    expect(api!.calls.some((c) => c.method === "Create")).toBe(false);
  });

  it("--json prints one parseable document and nothing else", async () => {
    const env = await withApi();
    const res = await cli(["https://example.com/talk.mp4", "--json"], { env });
    expect(res.code).toBe(0);
    const parsed: any = JSON.parse(res.stdout);
    expect(parsed.id).toBe(VIDEO_ID);
    // Wire format, not protobuf JSON.
    expect(parsed).toHaveProperty("app_id");
    expect(res.stderr).toBe("");
  });

  it("--own-bucket switches to a job written to the caller's origin", async () => {
    const env = await withApi();
    const res = await cli(
      ["https://example.com/talk.mp4", "--own-bucket", "ori_a1b2c3d4e5f6"],
      { env },
    );
    expect(res.code).toBe(0);
    const call = api!.calls.find((c) => c.method === "Create")!;
    expect(call.body.output_origin_id).toBe("ori_a1b2c3d4e5f6");
    expect(call.body.managed).toBeFalsy();
    expect(call.body.outputs[0].type).toBe("hls");
    expect(res.stdout).toContain(JOB_ID);
  });

  it("--mp4 asks for a single 1080p MP4 on a managed job", async () => {
    const env = await withApi();
    await cli(["https://example.com/talk.mp4", "--mp4"], { env });
    const call = api!.calls.find((c) => c.method === "Create")!;
    expect(call.body.managed).toBe(true);
    expect(call.body.outputs).toHaveLength(1);
    expect(call.body.outputs[0].type).toBe("mp4");
    expect(call.body.outputs[0].video[0]).toMatchObject({ codec: "h264", resolution: "1080p" });
  });

  it("--hls asks for a three-rung H.264 ladder", async () => {
    const env = await withApi();
    await cli(["https://example.com/talk.mp4", "--hls"], { env });
    const call = api!.calls.find((c) => c.method === "Create")!;
    expect(call.body.outputs[0].video.map((v: any) => v.resolution)).toEqual([
      "1080p",
      "720p",
      "480p",
    ]);
  });

  it("rejects --hls together with --mp4", async () => {
    const env = await withApi();
    const res = await cli(["https://example.com/talk.mp4", "--hls", "--mp4"], { env });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("mutually exclusive");
  });

  it("rejects an --own-bucket value that is not an origin id", async () => {
    const env = await withApi();
    const res = await cli(["https://example.com/talk.mp4", "--own-bucket", "my-bucket"], { env });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("ori_");
  });

  // Each of these streams keeps emitting AFTER the terminal status. A CLI that
  // does not actually stop on the terminal status reports the trailing frame
  // instead, which is what makes these tests bite.
  it("--wait stops at the terminal status and ignores anything after it", async () => {
    const env = await withApi({ watchStatuses: ["processing", "ready", "uploading"] });
    const res = await cli(["https://example.com/talk.mp4", "--wait", "--json"], { env });
    expect(res.code).toBe(0);
    expect(api!.calls.some((c) => c.method === "Watch")).toBe(true);
    expect(JSON.parse(res.stdout).status).toBe("ready");
  });

  it("--wait exits 1 when the video ends in error", async () => {
    const env = await withApi({ watchStatuses: ["processing", "error", "uploading"] });
    const res = await cli(["https://example.com/talk.mp4", "--wait", "--json"], { env });
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).status).toBe("error");
  });

  it("--wait stops on `deleted`, the third of the API's terminal statuses", async () => {
    // `domain.Video.IsTerminal` is ready | error | deleted — there is no
    // "failed" video status. A CLI holding the wrong set runs past this frame.
    const env = await withApi({ watchStatuses: ["processing", "deleted", "uploading"] });
    const res = await cli(["https://example.com/talk.mp4", "--wait", "--json"], { env });
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).status).toBe("deleted");
  });

  it.each([
    ["completed", 0],
    ["failed", 1],
    ["canceled", 1],
    ["partial", 1],
  ])("--wait on a job that ends %s exits %i", async (status, code) => {
    const env = await withApi({ watchStatuses: ["processing", status, "pending"] });
    const res = await cli(["https://example.com/talk.mp4", "--mp4", "--wait", "--json"], { env });
    expect(res.code).toBe(code);
    expect(JSON.parse(res.stdout).status).toBe(status);
  });
});

describe("transcodely <file>", () => {
  it("uploads the file and reports the video", async () => {
    const env = await withApi();
    const path = await fixture("clip.mp4", 2048);
    const res = await cli([path, "--title", "Clip"], { env });
    expect(res.code).toBe(0);
    expect(api!.puts).toEqual([{ url: "/s3/single", size: 2048 }]);
    expect(api!.calls.map((c) => c.method)).toEqual(["CreateUpload", "CompleteUpload"]);
    expect(api!.calls[0]!.body).toMatchObject({ filename: "clip.mp4", content_type: "video/mp4" });
    expect(res.stdout).toContain(VIDEO_ID);
  });

  // The docs' quick start is `npx @transcodely/sdk upload ./video.mp4`. Before
  // `upload` was a verb, the word was taken as a second input and refused with
  // "one input at a time".
  it("takes an explicit `upload` verb before the file", async () => {
    const env = await withApi();
    const path = await fixture("clip.mp4", 2048);
    const res = await cli(["upload", path, "--title", "Clip"], { env });
    expect(res.code).toBe(0);
    expect(api!.puts).toEqual([{ url: "/s3/single", size: 2048 }]);
    expect(api!.calls.map((c) => c.method)).toEqual(["CreateUpload", "CompleteUpload"]);
    expect(api!.calls[0]!.body).toMatchObject({ filename: "clip.mp4", title: "Clip" });
  });

  it("takes an explicit `upload` verb before a URL", async () => {
    const env = await withApi();
    const res = await cli(["upload", "https://example.com/talk.mp4", "--json"], { env });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).id).toBe(VIDEO_ID);
    expect(api!.calls.map((c) => c.method)).toEqual(["CreateFromUrl"]);
  });

  it("asks for an input when `upload` has none", async () => {
    const env = await withApi();
    const res = await cli(["upload"], { env });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("give me a file path");
    expect(api!.calls).toHaveLength(0);
  });

  it("uploads a file literally named `upload` when given as a path", async () => {
    const env = await withApi();
    const path = await fixture("upload", 2048);
    const res = await cli([path], { env });
    expect(res.code).toBe(0);
    expect(api!.calls[0]!.body).toMatchObject({ filename: "upload" });
  });

  it("refuses --own-bucket for an uploaded file and explains why", async () => {
    const env = await withApi();
    const path = await fixture("clip.mp4", 2048);
    const res = await cli([path, "--own-bucket", "ori_a1b2c3d4e5f6"], { env });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("managed storage");
    expect(api!.calls).toHaveLength(0);
  });

  it("exits 2 when the path does not exist", async () => {
    const env = await withApi();
    const res = await cli([join(tmp, "missing.mp4")], { env });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("cannot read");
  });

  it("names the scheme it cannot take instead of blaming the filesystem", async () => {
    const env = await withApi();
    const res = await cli(["s3://my-bucket/source.mp4"], { env });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("http(s) URL");
    expect(res.stderr).not.toContain("cannot read");
  });

  // The API takes an API-key caller's own app when app_id is omitted (api
  // video.proto, CreateUploadRequest / CreateMultipartUploadRequest /
  // CreateVideoFromUrlRequest `app_id`). The CLI used to refuse first with
  // "this command needs an app", so the docs' one-liner
  // `npx @transcodely/sdk upload ./video.mp4` failed for anyone who had only
  // exported a key.
  it("uploads under the key's own app when no app is known", async () => {
    const env = await withApi();
    const path = await fixture("clip.mp4", 2048);
    const res = await cli(["upload", path], {
      env: { ...env, TRANSCODELY_APP_ID: undefined },
    });
    expect(res.code).toBe(0);
    expect(api!.calls.map((c) => c.method)).toEqual(["CreateUpload", "CompleteUpload"]);
    expect(api!.calls[0]!.body.app_id ?? "").toBe(""); // "" is "omitted" to the API (IGNORE_IF_ZERO_VALUE)
  });

  it("ingests a URL under the key's own app when no app is known", async () => {
    const env = await withApi();
    const res = await cli(["https://example.com/talk.mp4", "--json"], {
      env: { ...env, TRANSCODELY_APP_ID: undefined },
    });
    expect(res.code).toBe(0);
    expect(api!.calls.map((c) => c.method)).toEqual(["CreateFromUrl"]);
    expect(api!.calls[0]!.body.app_id ?? "").toBe(""); // "" is "omitted" to the API (IGNORE_IF_ZERO_VALUE)
  });

  it("still sends the app when one is known", async () => {
    const env = await withApi();
    const path = await fixture("clip.mp4", 2048);
    const res = await cli([path, "--app", "app_zzzzzzzzzz"], { env });
    expect(res.code).toBe(0);
    expect(api!.calls[0]!.body.app_id).toBe("app_zzzzzzzzzz");
  });
});

describe("jobs and videos", () => {
  it("jobs ls prints a table", async () => {
    const env = await withApi({
      jobs: [jobJson("completed", { progress: 100 }), jobJson("failed", { id: "job_zzzzzzzzzzzz" })],
    });
    const res = await cli(["jobs", "ls"], { env });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("JOB");
    expect(res.stdout).toContain("completed");
    expect(res.stdout).toContain("job_zzzzzzzzzzzz");
  });

  it("jobs ls --json emits the jobs array", async () => {
    const env = await withApi();
    const res = await cli(["jobs", "ls", "--json"], { env });
    const parsed: any = JSON.parse(res.stdout);
    expect(parsed.jobs[0].id).toBe(JOB_ID);
    expect(parsed.jobs[0].status).toBe("completed");
  });

  it("jobs ls --limit is passed through and validated", async () => {
    const env = await withApi();
    await cli(["jobs", "ls", "--limit", "5"], { env });
    expect(api!.calls[0]!.body.pagination.limit).toBe(5);

    const bad = await cli(["jobs", "ls", "--limit", "0"], { env });
    expect(bad.code).toBe(2);
  });

  it("jobs ls --status maps a lowercase name onto the enum", async () => {
    const env = await withApi();
    await cli(["jobs", "ls", "--status", "completed"], { env });
    expect(api!.calls[0]!.body.status).toBe("completed");

    const bad = await cli(["jobs", "ls", "--status", "nonsense"], { env });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unknown --status");
  });

  it("jobs get prints the job", async () => {
    const env = await withApi();
    const res = await cli(["jobs", "get", JOB_ID], { env });
    expect(res.code).toBe(0);
    expect(api!.calls[0]!.body.id).toBe(JOB_ID);
    expect(res.stdout).toContain("completed");
  });

  it("jobs get without an id exits 2", async () => {
    const env = await withApi();
    const res = await cli(["jobs", "get"], { env });
    expect(res.code).toBe(2);
  });

  it("videos get prints the video and its renditions", async () => {
    const env = await withApi();
    const res = await cli(["videos", "get", VIDEO_ID], { env });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("play.transcodely.com");
    expect(res.stdout).toContain("1080p");
  });

  it("an unknown subcommand exits 2", async () => {
    const env = await withApi();
    expect((await cli(["jobs", "frobnicate"], { env })).code).toBe(2);
    expect((await cli(["videos", "ls"], { env })).code).toBe(2);
  });
});

describe("API errors", () => {
  it("exit 1 with the API code and message on stderr, nothing on stdout", async () => {
    const env = await withApi({
      errors: {
        CreateFromUrl: {
          status: 503,
          code: "hosting_provisioning_failed",
          message: "could not provision managed storage",
        },
      },
    });
    const res = await cli(["https://example.com/talk.mp4"], { env });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("could not provision managed storage");
    expect(res.stdout).toBe("");
  });

  it("a 404 from jobs get is an API error, not a usage error", async () => {
    const env = await withApi({
      errors: { Get: { status: 404, code: "job_not_found", message: "no such job" } },
    });
    const res = await cli(["jobs", "get", JOB_ID], { env });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no such job");
  });
});

describe("transcodely import urls", () => {
  const importCalls = () => api!.calls.filter((c) => c.service === "transcodely.v1.ImportService");

  async function csv(name: string, text: string): Promise<string> {
    const path = join(tmp, name);
    await writeFile(path, text);
    return path;
  }

  it("creates a draft import from a CSV, sends each column, and prints the quote", async () => {
    const env = await withApi();
    const file = await csv(
      "library.csv",
      'url,external_id,title,duration_seconds\n' +
        'https://example.com/a.mp4,a-1,"Talk, part one",600\n' +
        "https://example.com/b.mp4,b-1,,\n",
    );
    const res = await cli(["import", "urls", file, "--max-spend", "25"], { env });
    // The id is named as soon as the draft exists.
    expect(res.stderr).toBe(`created draft import ${IMPORT_ID}\n`);
    expect(res.code).toBe(0);
    const calls = importCalls();
    expect(calls.map((c) => c.method)).toEqual(["Create"]);
    expect(calls[0]!.body).toMatchObject({
      app_id: "app_k1l2m3n4o5",
      source: { type: "urls" },
      max_spend_eur: 25,
      items: [
        { url: "https://example.com/a.mp4", external_id: "a-1", title: "Talk, part one", duration_seconds: 600 },
        { url: "https://example.com/b.mp4", external_id: "b-1" },
      ],
    });
    expect(calls[0]!.body.items[1].title).toBe("");
    expect(res.stdout).toContain(`Import ${IMPORT_ID} (draft)`);
    expect(res.stdout).toMatch(/items\s+2/);
    expect(res.stdout).toMatch(/est\. encode\s+EUR 1\.25/);
    expect(res.stdout).toMatch(/spend cap\s+EUR 25\.00/);
    expect(res.stdout).toContain("1 items, not in the estimate");
    expect(res.stdout).toContain("Run with --start");
  });

  it("--start starts it under the same cap", async () => {
    const env = await withApi();
    const file = await csv("urls.txt", "https://example.com/a.mp4\nhttps://example.com/b.mp4\n");
    const res = await cli(["import", "urls", file, "--max-spend", "10", "--start", "--json"], { env });
    expect(res.code).toBe(0);
    const calls = importCalls();
    expect(calls.map((c) => c.method)).toEqual(["Create", "Start"]);
    expect(calls[1]!.body).toMatchObject({ id: IMPORT_ID, max_spend_eur: 10, app_id: "app_k1l2m3n4o5" });
    const doc: any = JSON.parse(res.stdout);
    expect(doc.import.status).toBe("running");
    expect(doc.import.quote.item_count).toBe(2);
  });

  it("sends more than 1,000 rows as Create plus AddItems batches of at most 1,000", async () => {
    const env = await withApi();
    const lines = Array.from({ length: 2500 }, (_, i) => `https://example.com/${String(i)}.mp4`);
    const file = await csv("big.csv", `${lines.join("\n")}\n`);
    const res = await cli(["import", "urls", file, "--max-spend", "100", "--json"], { env });
    expect(res.code).toBe(0);
    const calls = importCalls();
    expect(calls.map((c) => [c.method, c.body.items.length])).toEqual([
      ["Create", 1000],
      ["AddItems", 1000],
      ["AddItems", 500],
    ]);
    expect(calls[1]!.body.id).toBe(IMPORT_ID);
    expect(calls[2]!.body.items[499].url).toBe("https://example.com/2499.mp4");
    expect(JSON.parse(res.stdout).import.quote.item_count).toBe(2500);
  });

  it("requires --max-spend and calls nothing without it", async () => {
    const env = await withApi();
    const file = await csv("a.csv", "https://example.com/a.mp4\n");
    const res = await cli(["import", "urls", file], { env });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--max-spend");
    expect(api!.calls).toEqual([]);
  });

  it.each(["0", "-5", "ten", ""])("refuses --max-spend %j", async (cap) => {
    const env = await withApi();
    const file = await csv("a.csv", "https://example.com/a.mp4\n");
    const res = await cli(["import", "urls", file, `--max-spend=${cap}`], { env });
    expect(res.code).toBe(2);
    expect(api!.calls).toEqual([]);
  });

  it("refuses a file over 10,000 URLs before creating anything", async () => {
    const env = await withApi();
    const lines = Array.from({ length: 10_001 }, (_, i) => `https://example.com/${String(i)}.mp4`);
    const file = await csv("huge.csv", lines.join("\n"));
    const res = await cli(["import", "urls", file, "--max-spend", "5"], { env });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("at most 10000");
    expect(api!.calls).toEqual([]);
  });

  it("surfaces a refused start with the API's code and its hint", async () => {
    const env = await withApi({
      errors: {
        Start: {
          status: 429,
          code: "resource_exhausted",
          errorCode: "limit_exceeded",
          message: "app monthly spend limit reached",
        },
      },
    });
    const file = await csv("a.csv", "https://example.com/a.mp4\n");
    const res = await cli(["import", "urls", file, "--max-spend", "5", "--start"], { env });
    expect(res.code).toBe(1);
    // Exactly one Start: a quota refusal is not retried.
    expect(importCalls().map((c) => c.method)).toEqual(["Create", "Start"]);
    expect(res.stderr).toContain("limit_exceeded: app monthly spend limit reached");
    expect(res.stderr).toContain("over its monthly spend limit");
    // The draft it did create is named before the refusal.
    expect(res.stdout).toContain(`Import ${IMPORT_ID} (draft)`);
  });

  it.each([[false], [true]])(
    "names the draft when an AddItems batch fails (--json %s)",
    async (json) => {
      const env = await withApi({
        errors: { AddItems: { status: 400, code: "failed_precondition", errorCode: "import_invalid_state", message: "import is not a draft" } },
      });
      const lines = Array.from({ length: 1500 }, (_, i) => `https://example.com/${String(i)}.mp4`);
      const file = await csv("big.csv", lines.join("\n"));
      const res = await cli(["import", "urls", file, "--max-spend", "5", ...(json ? ["--json"] : [])], { env });
      expect(res.code).toBe(1);
      expect(importCalls().map((c) => c.method)).toEqual(["Create", "AddItems"]);
      expect(res.stderr).toContain(
        `adding items 1001-1500 failed; draft import ${IMPORT_ID} holds the first 1000 of 1500 items`,
      );
      expect(res.stderr).toContain("import_invalid_state: import is not a draft");
      if (json) expect(JSON.parse(res.stdout).error.code).toBe("import_invalid_state");
    },
  );

  it("sends an Idempotency-Key on every ImportService write, and none on reads", async () => {
    const seen: Record<string, string | null> = {};
    const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
      seen[String(u).split("/").pop()!] = (init!.headers as Headers).get("idempotency-key");
      const body = String(u).endsWith("/List") || String(u).endsWith("/ListItems") ? {} : { import: { id: IMPORT_ID } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const { Transcodely } = await import("@transcodely/sdk");
    const c = new Transcodely({ apiKey: "ak_x", baseUrl: "https://example.invalid", fetchImpl });
    await c.imports.create({ items: [{ url: "https://x/a.mp4" }] });
    await c.imports.addItems({ id: IMPORT_ID, items: [{ url: "https://x/b.mp4" }] });
    await c.imports.start({ id: IMPORT_ID, maxSpendEur: 5 });
    await c.imports.update({ id: IMPORT_ID, maxSpendEur: 6 });
    await c.imports.pause(IMPORT_ID);
    await c.imports.resume(IMPORT_ID);
    await c.imports.cancel(IMPORT_ID);
    await c.imports.get(IMPORT_ID);
    await c.imports.list().fetch();
    await c.imports.listItems({ id: IMPORT_ID }).fetch();
    for (const m of ["Create", "AddItems", "Start", "Update", "Pause", "Resume", "Cancel"]) {
      expect(seen[m], m).toMatch(/^[0-9a-f-]{36}$/);
    }
    for (const m of ["Get", "List", "ListItems"]) expect(seen[m], m).toBeNull();
  });

  it("names a missing subcommand or file as a usage error", async () => {
    expect((await cli(["import"], { env: { TRANSCODELY_API_KEY: "ak_x" } })).code).toBe(2);
    expect((await cli(["import", "csv", "x.csv"], { env: { TRANSCODELY_API_KEY: "ak_x" } })).code).toBe(2);
    expect((await cli(["import", "urls", "--max-spend", "5"], { env: { TRANSCODELY_API_KEY: "ak_x" } })).code).toBe(2);
  });
});

describe("the inlined import source type", () => {
  it("is ImportSourceType.URLS", () => {
    expect(SOURCE_TYPE_URLS).toBe(ImportSourceType.URLS);
  });
});

describe("parseImportCsv", () => {
  it("reads quoted fields with commas, quotes, line breaks and CRLF", () => {
    const rows = parseImportCsv(
      '\uFEFFurl,title,description\r\nhttps://x/a.mp4,"He said ""hi""","line one\nline two"\r\n\r\n',
    );
    expect(rows).toEqual([{ url: "https://x/a.mp4", title: 'He said "hi"', description: "line one\nline two" }]);
  });

  it("takes a header in any case and column order", () => {
    expect(parseImportCsv("Visibility,URL\nprivate,https://x/a.mp4\n")).toEqual([
      { url: "https://x/a.mp4", visibility: "private" },
    ]);
  });

  it("refuses an unknown column instead of dropping it", () => {
    expect(() => parseImportCsv("url,titel\nhttps://x/a.mp4,Hello\n")).toThrow(/unknown CSV column "titel"/);
  });

  it("refuses a header with no url column", () => {
    expect(() => parseImportCsv("title\nHello\n")).toThrow(/"url" column/);
  });

  it("refuses a row with more fields than the header, naming the line", () => {
    expect(() => parseImportCsv("https://x/a.mp4\nhttps://x/b.mp4,extra\n")).toThrow(/row 2 has 2 fields/);
  });

  it("refuses a row with no url and a non-numeric duration", () => {
    expect(() => parseImportCsv("url,title\n,Hello\n")).toThrow(/row 2 has no url/);
    expect(() => parseImportCsv("url,duration_seconds\nhttps://x/a.mp4,long\n")).toThrow(/duration_seconds/);
  });

  it("refuses a header that names a column twice", () => {
    expect(() => parseImportCsv("url,title,Title\nhttps://x/a.mp4,A,B\n")).toThrow(/names "title" twice/);
  });

  it("refuses text after a closing quote, naming the row", () => {
    expect(() => parseImportCsv('url,title\nhttps://x/a.mp4,"Hello" world\n')).toThrow(
      /row 2: text after a closing quote/,
    );
    // A closing quote followed by a separator, a line break or the end is fine.
    expect(parseImportCsv('url,title\r\n"https://x/a.mp4","Hi"')).toEqual([{ url: "https://x/a.mp4", title: "Hi" }]);
  });

  it("refuses an unterminated quote", () => {
    expect(() => parseImportCsv('url,title\nhttps://x/a.mp4,"open\n')).toThrow(/quoted field/);
  });
});
