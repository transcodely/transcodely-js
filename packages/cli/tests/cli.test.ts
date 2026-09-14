import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TERMINAL_VIDEO } from "../src/commands/upload.js";
import { fileStore, type CredentialStore } from "../src/credentials.js";
import { run } from "../src/main.js";
import { JOB_ID, VIDEO_ID, jobJson, startMockApi, type MockApi, type MockApiOptions } from "./mock-api.js";

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
    expect(res.stdout).toMatchSnapshot();
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

  it("exits 2 when no app is known", async () => {
    const env = await withApi();
    const path = await fixture("clip.mp4", 2048);
    const res = await cli([path], {
      env: { ...env, TRANSCODELY_APP_ID: undefined },
    });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--app");
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
