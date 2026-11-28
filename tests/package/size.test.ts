/**
 * The size budget for a browser app that renders <TranscodelyUploader>: the
 * upload core plus the React layer, compressed, under 8 KB (brief 15).
 * gzip at its default level, as a CDN or bundler report would show it.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

// dist/ is built, when missing, by the global setup in tests/package/build.ts.
import { ROOT } from "./build.js";

const BUDGET = 8192;

async function gzipped(path: string): Promise<number> {
  return gzipSync(await readFile(join(ROOT, "dist", path))).length;
}

describe("the browser bundle budget", () => {
  it(`keeps gzip(upload/index.mjs) + gzip(react/index.mjs) under ${BUDGET} bytes`, async () => {
    const core = await gzipped("upload/index.mjs");
    const react = await gzipped("react/index.mjs");
    // Logged so a change that eats into the budget is visible before it fails.
    console.log(`browser bundle: core ${core} B + react ${react} B = ${core + react} B gzip (budget ${BUDGET})`);
    expect(core).toBeGreaterThan(0);
    expect(react).toBeGreaterThan(0);
    expect(core + react).toBeLessThan(BUDGET);
  });
});
