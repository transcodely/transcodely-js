// Runs after `tsup --config tsup.subpaths.config.ts` (see that file). The
// server and React declarations import the upload core's types; rollup-plugin-dts
// leaves that import pointing into src/. Point it at the published specifier so
// consumers resolve the one copy in dist/upload/index.d.ts. Fails the build if
// any declaration still reaches into src/ afterwards.
import { readFile, writeFile } from "node:fs/promises";

const FILES = [
  "dist/upload/server.d.ts",
  "dist/upload/server.d.cts",
  "dist/react/index.d.ts",
  "dist/react/index.d.cts",
];

for (const file of FILES) {
  const code = await readFile(file, "utf8");
  // dist/upload/server.* sits beside the core, so rollup may write "./index.ts"
  // there; from dist/react/ the core is "../browser-upload/index.ts" or similar.
  const core = file.startsWith("dist/upload/")
    ? /(["'])(?:\.\.?\/)+(?:(?:src\/)?browser-upload\/)?index(?:\.d)?(?:\.[cm]?[jt]s)?\1/g
    : /(["'])(?:\.\.?\/)+(?:src\/)?browser-upload\/index(?:\.d)?(?:\.[cm]?[jt]s)?\1/g;
  const fixed = code.replace(core, '"@transcodely/sdk/upload"');
  // Any relative specifier left is a path that exists only in this repo.
  const relative = fixed.match(/\bfrom\s*["']\.{1,2}\/[^"']*["']|\bimport\(\s*["']\.{1,2}\/[^"']*["']\s*\)/);
  if (relative) throw new Error(`${file} still has a relative import: ${relative[0]}`);
  if (fixed !== code) await writeFile(file, fixed);
}
