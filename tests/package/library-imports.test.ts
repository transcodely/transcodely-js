/**
 * The library entry must not carry the CLI.
 *
 * @transcodely/sdk ships the CLI as a `bin` (dist/bin/transcodely.mjs). That
 * is only free for library users — including browser builds — while none of
 * the CLI's code or its Node-only imports (child_process, readline, os, util)
 * reach `dist/index.*`. This pins the library bundles' complete set of module
 * imports and checks that no CLI source went into them, so wiring the CLI into
 * `src/index.ts` (or a shared module importing it) fails here rather than
 * silently growing every bundle that imports the SDK.
 *
 * The allowlist is the set the library had before the bin existed. `crypto`
 * is the webhook signature check; `fs/promises` and `path` are dynamic
 * imports inside the Node-only upload-from-path helper, so a browser bundler
 * never evaluates them. Adding a module here is a deliberate decision about
 * what every SDK consumer pulls in.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// dist/ is built, when missing, by the global setup in tests/package/build.ts.
import { ROOT } from "./build.js";

const LIBRARY_IMPORTS = ["@bufbuild/protobuf", "crypto", "fs/promises", "path"];

/** Every module specifier a bundle imports, statically or dynamically. */
function moduleSpecifiers(code: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /^import\s[^;]*?\sfrom\s*['"]([^'"]+)['"];?\s*$/gm, // import { x } from 'y';
    /^import\s*['"]([^'"]+)['"];?\s*$/gm, //                import 'y';
    /^export\s[^;]*?\sfrom\s*['"]([^'"]+)['"];?\s*$/gm, // export { x } from 'y';
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.add(match[1]!.replace(/^node:/, ""));
  }
  return [...found].sort();
}

describe.each(["index.mjs", "index.cjs"])("dist/%s", (file) => {
  it("imports exactly the library's own modules", async () => {
    const code = await readFile(join(ROOT, "dist", file), "utf8");
    expect(moduleSpecifiers(code)).toEqual(LIBRARY_IMPORTS);
  });

  it("contains no CLI source", async () => {
    const map = JSON.parse(await readFile(join(ROOT, "dist", `${file}.map`), "utf8")) as {
      sources: string[];
    };
    expect(map.sources.length).toBeGreaterThan(0);
    expect(map.sources.filter((s) => s.includes("packages/cli"))).toEqual([]);
    const code = await readFile(join(ROOT, "dist", file), "utf8");
    // The help text is the CLI's largest string and appears nowhere else.
    expect(code).not.toContain("The CLI sends no telemetry");
  });
});

describe("the import-graph check itself", () => {
  // Guards against a regex that silently matches nothing: if it found no
  // imports, the equality above would fail anyway, but a regex that misses
  // only Node builtins would not. Point it at the bin, which uses them.
  it("sees the Node builtins the bin imports", async () => {
    const code = await readFile(join(ROOT, "dist", "bin", "transcodely.mjs"), "utf8");
    const specifiers = moduleSpecifiers(code);
    expect(specifiers).toContain("child_process");
    expect(specifiers).toContain("readline/promises");
    expect(specifiers).toContain("@transcodely/sdk");
  });
});

describe("package.json", () => {
  it("exposes the bin without naming it in the exports map", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
      bin: Record<string, string>;
      exports: unknown;
    };
    expect(pkg.bin).toEqual({ transcodely: "./dist/bin/transcodely.mjs" });
    expect(JSON.stringify(pkg.exports)).not.toContain("bin");
  });
});
