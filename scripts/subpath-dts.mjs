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
  const fixed = code.replace(
    /(["'])(?:\.\.?\/)+(?:src\/)?browser-upload\/index(?:\.[jt]s)?\1/g,
    '"@transcodely/sdk/upload"',
  );
  if (/["'](?:\.\.?\/)+(?:src|browser-upload|react)\//.test(fixed)) {
    throw new Error(`${file} still imports a source path`);
  }
  if (fixed !== code) await writeFile(file, fixed);
}
