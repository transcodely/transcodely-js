/**
 * The browser-upload subpaths as a user installs them: the tarball `npm
 * publish` would upload (`npm pack`), unpacked into a fresh
 * `node_modules/@transcodely/sdk` with only `@bufbuild/protobuf` beside it.
 * No React is installed, so `/upload` and `/upload/server` prove they need
 * none; `/react` is type-checked against React 18's and React 19's types,
 * each linked in turn as the project's `@types/react`.
 */

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// dist/ is built, when missing, by the global setup in tests/package/build.ts.
import { ROOT, run } from "./build.js";

const exec = promisify(execFile);

interface PackResult {
  filename: string;
  files: { path: string }[];
}

let tmp: string;
let app: string;
let pkgDir: string;
let pack: PackResult;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "transcodely-sdk-subpaths-"));
  // --ignore-scripts: `prepare` is husky, which would rewrite this checkout's
  // git hook config.
  const { stdout } = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tmp], {
    cwd: ROOT,
  });
  pack = (JSON.parse(stdout) as PackResult[])[0]!;

  app = join(tmp, "app");
  pkgDir = join(app, "node_modules", "@transcodely", "sdk");
  await mkdir(pkgDir, { recursive: true });
  await exec("tar", ["-xzf", join(tmp, pack.filename), "-C", pkgDir, "--strip-components=1"]);
  await mkdir(join(app, "node_modules", "@bufbuild"), { recursive: true });
  await symlink(
    realpathSync(join(ROOT, "node_modules", "@bufbuild", "protobuf")),
    join(app, "node_modules", "@bufbuild", "protobuf"),
  );
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "app", private: true }));
}, 240_000);

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

async function node(args: string[]): Promise<string> {
  const { stdout } = await exec(process.execPath, args, { cwd: app, env: { PATH: process.env.PATH ?? "" } });
  return stdout;
}

describe("the packed tarball", () => {
  it("installs with no React anywhere", async () => {
    await expect(node(["-e", "require.resolve('react')"])).rejects.toThrow(/Cannot find module 'react'/);
  });

  it("ships the subpath builds and the stylesheet", () => {
    const paths = pack.files.map((f) => f.path);
    for (const entry of ["upload/index", "upload/server", "react/index"]) {
      for (const ext of ["mjs", "cjs", "d.ts", "d.cts"]) expect(paths).toContain(`dist/${entry}.${ext}`);
    }
    expect(paths).toContain("dist/react/styles.css");
  });

  it("ships no React code and no sources", async () => {
    const paths = pack.files.map((f) => f.path);
    expect(paths.filter((p) => /node_modules|^src\/|^tests\/|\.tsx$/.test(p))).toEqual([]);
    for (const path of paths.filter((p) => /\.(m|c)?js$/.test(p))) {
      const code = await readFile(join(pkgDir, path), "utf8");
      // Markers of React's own runtime, present in any bundled copy of it.
      expect(code, path).not.toMatch(/react\.(transitional\.)?element|__SECRET_INTERNALS|__CLIENT_INTERNALS|react\.fragment/);
    }
  });
});

describe("@transcodely/sdk/upload and /upload/server without React", () => {
  const PROBE = `const u = M1; const s = M2;
    console.log(JSON.stringify({
      core: ["createUpload", "partSizeFor", "acceptsFile", "memoryStore", "indexedDBStore", "TranscodelyUploadError", "MAX_FILE_SIZE", "MAX_PARTS", "MIN_PART_SIZE"].filter((k) => !(k in u)),
      server: typeof s.createUploadHandler,
      max: u.MAX_FILE_SIZE,
    }));`;
  const expected = { core: [], server: "function", max: 5_368_709_120 };

  it("imports as ESM", async () => {
    const code = `import * as a from "@transcodely/sdk/upload"; import * as b from "@transcodely/sdk/upload/server";
      ${PROBE.replace("M1", "a").replace("M2", "b")}`;
    expect(JSON.parse(await node(["--input-type=module", "-e", code]))).toEqual(expected);
  });

  it("requires as CommonJS", async () => {
    const code = PROBE.replace("M1", 'require("@transcodely/sdk/upload")').replace(
      "M2",
      'require("@transcodely/sdk/upload/server")',
    );
    expect(JSON.parse(await node(["-e", code]))).toEqual(expected);
  });

  it("resolves the server's core import to the package's one core", async () => {
    const code = `import { createRequire } from "node:module";
      const r = createRequire(import.meta.url);
      console.log(import.meta.resolve("@transcodely/sdk/upload") + " " + r.resolve("@transcodely/sdk/upload"));`;
    const [esm, cjs] = (await node(["--input-type=module", "-e", code])).trim().split(" ");
    expect(esm).toMatch(/node_modules\/@transcodely\/sdk\/dist\/upload\/index\.mjs$/);
    expect(cjs).toMatch(/node_modules\/@transcodely\/sdk\/dist\/upload\/index\.cjs$/);
  });
});

const USAGE = `import { TranscodelyUploader, useTranscodelyUpload, type UploadResult } from "@transcodely/sdk/react";
import { createUpload, type TranscodelyUploadError } from "@transcodely/sdk/upload";
import { createUploadHandler } from "@transcodely/sdk/upload/server";

export function Page() {
  const { start, pause, resume, cancel, retry, state, progress } = useTranscodelyUpload({
    endpoint: "/api/transcodely/upload",
    metadata: { title: (file) => file.name },
  });
  const done = (r: UploadResult) => r.videoId;
  const failed = (e: TranscodelyUploadError) => e.code;
  void [start, pause, resume, cancel, retry, createUpload];
  return (
    <div>
      <TranscodelyUploader
        endpoint="/api/transcodely/upload"
        accept="video/*"
        maxFileSize={2 * 1024 ** 3}
        className="uploader"
        messages={{ choose: "Drop a lecture" }}
        onSuccess={done}
        onError={failed}
        onProgress={({ percent }) => percent}
      />
      <p>{state} {progress.percent}</p>
    </div>
  );
}

export const POST = createUploadHandler({
  client: null as never,
  authorize: async () => ({ allow: true, defaults: { title: "x" } }),
});
`;

// A Next.js route handler, as the docs show it: a real client, and authorize
// returning defaults that are fields of CreateMultipartUploadRequest.
const SERVER_USAGE = `import { Transcodely } from "@transcodely/sdk";
import { createUploadHandler, type AuthorizeResult, type UploadDefaults } from "@transcodely/sdk/upload/server";

const client = new Transcodely({ apiKey: "ak_test" });
const defaults: UploadDefaults = { visibility: "private", tags: ["user:42"] };

export const POST: (request: Request) => Promise<Response> = createUploadHandler({
  client,
  secret: "a".repeat(32),
  maxFileSize: 2 * 1024 ** 3,
  accept: "video/*",
  ticketTtlSeconds: 3600,
  authorize: async (request, ctx): Promise<AuthorizeResult> => {
    if (!request.headers.get("cookie")) return { allow: false, status: 401, message: "Sign in to upload." };
    if (ctx.action === "create" && ctx.file && ctx.file.size > 0) return { allow: true, subject: "user_42", defaults };
    return { allow: true, subject: "user_42" };
  },
});
`;

// A plain-fetch app with no React, using the core directly.
const CORE_USAGE = `import {
  MAX_FILE_SIZE, acceptsFile, createUpload, indexedDBStore, memoryStore, partSizeFor,
  TranscodelyUploadError, type Upload, type UploadProgress, type UploadState,
} from "@transcodely/sdk/upload";

export async function send(file: File): Promise<string | undefined> {
  if (!acceptsFile(file, "video/*") || file.size > MAX_FILE_SIZE) return undefined;
  const upload: Upload = createUpload(file, {
    endpoint: "/api/transcodely/upload",
    headers: async () => ({ "x-csrf": "token" }),
    metadata: { title: file.name },
    concurrency: 4,
    store: indexedDBStore("my-app"),
    onProgress: (p: UploadProgress) => p.percent,
    onStateChange: (s: UploadState) => s,
  });
  const unsubscribe = upload.subscribe(() => upload.state);
  try {
    const { videoId, resumed } = await upload.start();
    return resumed ? videoId : videoId.toUpperCase();
  } catch (err) {
    if (err instanceof TranscodelyUploadError) return err.code;
    throw err;
  } finally {
    unsubscribe();
  }
}
export const fallback = memoryStore();
export const part: number = partSizeFor(1024);
`;

/**
 * Type-checks `source` as a page in the unpacked app, with `reactTypes` (an
 * entry of this repo's node_modules/@types) linked as the app's @types/react.
 * skipLibCheck is off, so the package's own declarations are checked too: an
 * unresolved `react` import inside dist/react/index.d.ts is an error here,
 * not a silent `any`. @types/node is present because the server handler's
 * types reach the main SDK's, which mention Buffer.
 */
async function typecheck(reactTypes: string, source: string): Promise<{ ok: boolean; out: string }> {
  const types = join(app, "node_modules", "@types");
  await mkdir(types, { recursive: true });
  await rm(join(types, "react"), { force: true });
  await symlink(realpathSync(join(ROOT, "node_modules", "@types", reactTypes)), join(types, "react"));
  await rm(join(types, "node"), { force: true });
  await symlink(realpathSync(join(ROOT, "node_modules", "@types", "node")), join(types, "node"));
  const dir = await mkdtemp(join(app, "check-"));
  await writeFile(join(dir, "page.tsx"), source);
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
      },
      files: ["page.tsx"],
    }),
  );
  try {
    const { stdout } = await exec(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", dir]);
    return { ok: true, out: stdout };
  } catch (err) {
    return { ok: false, out: (err as { stdout?: string }).stdout ?? String(err) };
  }
}

describe("@transcodely/sdk/upload/server and /upload in a TypeScript project", () => {
  it("type-checks a route handler with a real client and authorize defaults", async () => {
    const res = await typecheck("react", SERVER_USAGE);
    expect(res.out).toBe("");
    expect(res.ok).toBe(true);
  }, 60_000);

  it("rejects a defaults field CreateMultipartUploadRequest does not have", async () => {
    const res = await typecheck(
      "react",
      `import { createUploadHandler } from "@transcodely/sdk/upload/server";
export const POST = createUploadHandler({
  client: null as never,
  authorize: () => ({ allow: true, defaults: { visibilty: "private" } }),
});
`,
    );
    expect(res.ok).toBe(false);
    expect(res.out).toContain("visibilty");
  }, 60_000);

  it("rejects defaults that set the file's own facts", async () => {
    const res = await typecheck(
      "react",
      `import type { UploadDefaults } from "@transcodely/sdk/upload/server";
export const d: UploadDefaults = { sizeBytes: 1n };
`,
    );
    expect(res.ok).toBe(false);
    expect(res.out).toContain("sizeBytes");
  }, 60_000);

  it("type-checks a plain-fetch app using the core", async () => {
    const res = await typecheck("react", CORE_USAGE);
    expect(res.out).toBe("");
    expect(res.ok).toBe(true);
  }, 60_000);

  it("rejects a wrongly typed core option", async () => {
    const res = await typecheck(
      "react",
      `import { createUpload } from "@transcodely/sdk/upload";
export const u = createUpload(new File([], "a.mp4"), { endpoint: "/x", concurrency: "3" });
`,
    );
    expect(res.ok).toBe(false);
    expect(res.out).toMatch(/page\.tsx\(2,\d+\): error TS2322: Type 'string' is not assignable to type 'number'/);
  }, 60_000);
});

describe.each([
  ["@types/react 18", "react-18", "18."],
  ["@types/react 19", "react", "19."],
])("@transcodely/sdk/react against %s", (_label, reactTypes, major) => {
  it("is the version it claims to be", async () => {
    const manifest = JSON.parse(
      await readFile(join(realpathSync(join(ROOT, "node_modules", "@types", reactTypes)), "package.json"), "utf8"),
    ) as { version: string };
    expect(manifest.version.startsWith(major)).toBe(true);
  });

  it("type-checks a page using the component, the hook and the handler", async () => {
    const res = await typecheck(reactTypes, USAGE);
    expect(res.out).toBe("");
    expect(res.ok).toBe(true);
  }, 60_000);

  // The check has teeth: a wrong prop type is caught through the published d.ts.
  it("rejects a wrongly typed prop", async () => {
    const res = await typecheck(
      reactTypes,
      `import { TranscodelyUploader } from "@transcodely/sdk/react";\nexport const x = <TranscodelyUploader endpoint={42} />;\n`,
    );
    expect(res.ok).toBe(false);
    expect(res.out).toContain("page.tsx");
    expect(res.out).toMatch(/number.*string|endpoint/);
  }, 60_000);
});
