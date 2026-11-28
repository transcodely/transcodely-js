import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { defineConfig, type Options } from "tsup";

type Plugin = NonNullable<Options["esbuildPlugins"]>[number];

/**
 * The browser-upload subpaths of @transcodely/sdk, built apart from the
 * library so `tsup.config.ts` (and every byte of `dist/index.*`) is untouched:
 *
 *   @transcodely/sdk/upload         dist/upload/index.*   framework-free core
 *   @transcodely/sdk/upload/server  dist/upload/server.*  Request -> Response handler
 *   @transcodely/sdk/react          dist/react/index.*    hook + component ("use client")
 *   @transcodely/sdk/react/styles.css                     optional stylesheet, copied
 *
 * There is ONE copy of the core. The server and React builds reach it through
 * the published specifier `@transcodely/sdk/upload`, which Node resolves by
 * package self-reference to `dist/upload/index.*`. `coreExternal` rewrites their
 * relative imports of `src/browser-upload/index.ts` to that specifier; for the
 * declarations, rollup-plugin-dts keeps the core external (CORE_PATTERN matches
 * its resolved path) and `scripts/subpath-dts.mjs`, run next by `pnpm build`,
 * swaps the relative path it writes for the specifier. Were the core bundled
 * twice, state and `instanceof TranscodelyUploadError` would split between
 * the copies.
 *
 * React is a peer and never bundled. `tests/package/library-imports.test.ts`
 * pins every bundle's imports.
 */

const CORE = resolve("src/browser-upload/index.ts");
const CORE_PATTERN = new RegExp(`^${CORE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

const coreExternal: Plugin = {
  name: "core-external",
  setup(build) {
    build.onResolve({ filter: /^\.\.?\/(?:.*\/)?index(?:\.[jt]s)?$/ }, (args) => {
      const target = resolve(args.resolveDir, args.path).replace(/(\.js)?$/, "").replace(/\.ts$/, "");
      return `${target}.ts` === CORE ? { path: "@transcodely/sdk/upload", external: true } : undefined;
    });
  },
};

const shared: Options = {
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "es2022",
  // `pnpm build` runs the library build first, which cleans `dist/`.
  clean: false,
  dts: true,
  sourcemap: false,
  splitting: false,
  // tsup's treeshake re-bundles through rollup, which drops "use client".
  treeshake: false,
  minify: true,
  external: ["@transcodely/sdk", "@transcodely/sdk/upload", "react", "react-dom", "react/jsx-runtime", CORE_PATTERN],
  esbuildPlugins: [coreExternal],
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".cjs" };
  },
};

export default defineConfig([
  { ...shared, entry: { index: "src/browser-upload/index.ts" }, outDir: "dist/upload", esbuildPlugins: [] },
  { ...shared, entry: { server: "src/browser-upload/server.ts" }, outDir: "dist/upload" },
  {
    ...shared,
    entry: { index: "src/react/index.ts" },
    outDir: "dist/react",
    banner: { js: '"use client";' },
    async onSuccess() {
      // Read and write rather than copyFile, which on macOS keeps the source's
      // mtime and would make tests/package/build.ts see dist/ as stale forever.
      await writeFile("dist/react/styles.css", await readFile("src/react/styles.css"));
    },
  },
]);
