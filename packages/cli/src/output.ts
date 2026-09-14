/**
 * Printing. Two modes, chosen by `--json`:
 *
 *   - human: a few aligned lines, no colour, no spinners in a pipe;
 *   - json: exactly one JSON document on stdout and nothing else, so
 *     `transcodely … --json | jq` is always valid.
 *
 * Diagnostics and progress go to stderr in both modes, which keeps stdout a
 * clean data channel.
 */

import { toWireJson } from "@transcodely/sdk";
import type { Message } from "@bufbuild/protobuf";

import type { Ctx } from "./context.js";

export interface Printer {
  json: boolean;
  /** The result document. In json mode this is the only thing on stdout. */
  result(value: unknown): void;
  /** A line of human output. Suppressed entirely in json mode. */
  line(text: string): void;
  /** Progress or status, always stderr, suppressed in json mode. */
  note(text: string): void;
}

export function printer(ctx: Ctx, json: boolean): Printer {
  return {
    json,
    result(value) {
      if (json) ctx.stdout(`${JSON.stringify(value, null, 2)}\n`);
    },
    line(text) {
      if (!json) ctx.stdout(`${text}\n`);
    },
    note(text) {
      if (!json) ctx.stderr(`${text}\n`);
    },
  };
}

/** A generated message as the same JSON the API itself would return. */
export function wire<T extends Message<T>>(msg: T): unknown {
  return toWireJson(msg);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit] ?? "B"}`;
}

/** Left-aligned two-column block: `key   value`. */
export function fields(rows: [string, string | undefined][]): string {
  const present = rows.filter((r): r is [string, string] => r[1] !== undefined && r[1] !== "");
  const width = present.reduce((w, [k]) => Math.max(w, k.length), 0);
  return present.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join("\n");
}

/** Fixed-width table with a header row. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const render = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [render(headers), ...rows.map(render)].join("\n");
}
