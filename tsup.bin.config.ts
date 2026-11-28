import { defineConfig } from "tsup";

/**
 * The CLI, shipped a second way: as the `transcodely` bin of @transcodely/sdk,
 * so `npx @transcodely/sdk upload ./talk.mp4` works from the SDK's own
 * automated release. `packages/cli` stays the source (and its own package).
 *
 * Built into `dist/bin/`, which the `exports` map does not name — the library
 * entry never sees this file, and `tests/package/library-imports.test.ts`
 * fails if CLI code reaches `dist/index.*`.
 *
 * @transcodely/sdk stays external and resolves through Node's package
 * self-reference to this package's own `dist/index.mjs`, so the bin shares the
 * library's single copy (and `instanceof TranscodelyError` holds) instead of
 * inlining a second one.
 */
export default defineConfig({
  entry: { transcodely: "packages/cli/src/index.ts" },
  outDir: "dist/bin",
  format: ["esm"],
  platform: "node",
  target: "node20",
  // `pnpm build` runs the library build first, which cleans `dist/`; cleaning
  // here would delete nothing of ours but is not needed either.
  clean: false,
  dts: false,
  sourcemap: false,
  splitting: false,
  external: ["@transcodely/sdk", "@bufbuild/protobuf"],
  banner: { js: "#!/usr/bin/env node" },
  outExtension() {
    return { js: ".mjs" };
  },
});
