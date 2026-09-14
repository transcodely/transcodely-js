import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  dts: false,
  sourcemap: false,
  splitting: false,
  // Kept external so the published CLI installs the real @transcodely/sdk
  // rather than inlining a copy of it (and of its protobuf runtime).
  external: ["@transcodely/sdk", "@bufbuild/protobuf"],
  banner: { js: "#!/usr/bin/env node" },
  outExtension() {
    return { js: ".mjs" };
  },
});
