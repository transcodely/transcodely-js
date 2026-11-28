/**
 * `transcodely import urls <file.csv> --max-spend <eur> [--start]`
 *
 * Reads a CSV of source URLs, creates a bulk import (ImportService.Create,
 * then AddItems for every further 1,000 rows), prints the quote the API
 * returns, and with `--start` starts it under the same spend cap. Without
 * `--start` the import stays a draft: nothing is fetched, encoded or charged.
 *
 * The file is either one URL per line, or a CSV whose first row names its
 * columns: `url` (required) plus any of `external_id`, `title`,
 * `description`, `visibility` and `duration_seconds`. A column the CLI does not
 * know is refused rather than dropped, so a typo cannot silently lose data.
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { ImportSourceType, ImportStatus, type Import } from "@transcodely/sdk";

import { openSession, type Ctx } from "../context.js";
import { EXIT_OK, UsageError } from "../errors.js";
import { META_OPTIONS, meta } from "../meta.js";
import { fields, printer, wire } from "../output.js";

const OPTIONS = {
  "max-spend": { type: "string" },
  start: { type: "boolean" },
  json: { type: "boolean" },
  app: { type: "string" },
  "api-key": { type: "string" },
  "base-url": { type: "string" },
  ...META_OPTIONS,
} as const;

/** Items per Create / AddItems call, and per import (import.proto). */
const BATCH = 1000;
const MAX_ITEMS = 10_000;
/** CreateImportRequest.max_spend_eur's upper bound. */
const MAX_SPEND_EUR = 99_999_999;

const COLUMNS = new Set(["url", "external_id", "title", "description", "visibility", "duration_seconds"]);

export interface ImportRow {
  url: string;
  externalId?: string;
  title?: string;
  description?: string;
  visibility?: string;
  durationSeconds?: number;
}

export async function importCommand(ctx: Ctx, argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const flags = parsed.values;
  const asked = meta(ctx, flags);
  if (asked !== undefined) return asked;

  const [sub, file, ...extra] = parsed.positionals;
  if (sub !== "urls") {
    throw new UsageError(
      sub ? `unknown import subcommand "${sub}" — try urls` : "import needs a subcommand: urls <file.csv>",
    );
  }
  if (!file) throw new UsageError("import urls needs a CSV file of source URLs");
  if (extra.length > 0) throw new UsageError("one CSV file at a time");
  const maxSpendEur = spendCap(flags["max-spend"]);

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rows = parseImportCsv(text);
  if (rows.length === 0) throw new UsageError(`${file} has no URLs in it`);
  if (rows.length > MAX_ITEMS) {
    throw new UsageError(`${file} has ${String(rows.length)} URLs; an import takes at most ${String(MAX_ITEMS)}`);
  }

  const out = printer(ctx, flags.json ?? false);
  const session = await openSession(ctx, {
    ...(flags["api-key"] !== undefined ? { apiKey: flags["api-key"] } : {}),
    ...(flags.app !== undefined ? { app: flags.app } : {}),
    ...(flags["base-url"] !== undefined ? { baseUrl: flags["base-url"] } : {}),
  });
  const appId = session.appId !== undefined ? { appId: session.appId } : {};

  let imp = await session.client.imports.create({
    ...appId,
    source: { type: ImportSourceType.URLS },
    items: rows.slice(0, BATCH),
    maxSpendEur,
  });
  for (let i = BATCH; i < rows.length; i += BATCH) {
    out.note(`adding items ${String(i + 1)}-${String(Math.min(i + BATCH, rows.length))}`);
    imp = await session.client.imports.addItems({ ...appId, id: imp.id, items: rows.slice(i, i + BATCH) });
  }

  out.line(describeImport(imp));
  if (flags.start) {
    imp = await session.client.imports.start({ ...appId, id: imp.id, maxSpendEur });
    out.line(`Started: ${imp.id} is ${statusName(imp.status)}.`);
  } else {
    out.line("Draft only: nothing is fetched or encoded until it is started. Run with --start to start it.");
  }
  out.result({ import: wire(imp) });
  return EXIT_OK;
}

function spendCap(raw: string | undefined): number {
  if (raw === undefined) {
    throw new UsageError("import urls needs --max-spend <eur>: the most the import may spend");
  }
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n <= 0 || n > MAX_SPEND_EUR) {
    throw new UsageError(`--max-spend must be an amount in EUR above 0, got "${raw}"`);
  }
  return n;
}

function describeImport(imp: Import): string {
  const q = imp.quote;
  const eur = (n: number | undefined) => (n === undefined ? undefined : `EUR ${n.toFixed(2)}`);
  return [
    `Import ${imp.id} (${statusName(imp.status)})`,
    fields([
      ["items", q ? String(q.itemCount) : undefined],
      ["known minutes", q ? (q.knownDurationSeconds / 60).toFixed(1) : undefined],
      ["unknown length", q && q.unknownDurationItems > 0 ? `${String(q.unknownDurationItems)} items, not in the estimate` : undefined],
      ["est. encode", eur(q?.estimatedEncodeEur)],
      ["est. storage", q ? `${eur(q.estimatedStorageEurPerMonth) ?? ""} / month` : undefined],
      ["spend cap", eur(imp.maxSpendEur)],
    ]),
  ].join("\n");
}

function statusName(status: ImportStatus): string {
  return (ImportStatus[status] ?? "unknown").toLowerCase();
}

/**
 * The rows of an import CSV. One URL per line when the first row is a URL,
 * otherwise the first row is a header naming the columns (see the file
 * comment). Fields follow RFC 4180: double-quoted fields may hold commas,
 * line breaks and `""` for a quote. Blank lines are skipped.
 */
export function parseImportCsv(text: string): ImportRow[] {
  const records = csvRecords(text.replace(/^\uFEFF/, "")).filter((r) => r.some((f) => f.trim() !== ""));
  if (records.length === 0) return [];

  const first = records[0]!;
  const headerless = /^https?:\/\//i.test(first[0]?.trim() ?? "");
  const header = headerless ? ["url"] : first.map((h) => h.trim().toLowerCase());
  if (!headerless) {
    const unknown = header.filter((h) => !COLUMNS.has(h));
    if (unknown.length > 0) {
      throw new UsageError(
        `unknown CSV column "${unknown[0]!}" — the columns are ${[...COLUMNS].join(", ")}`,
      );
    }
    if (!header.includes("url")) throw new UsageError('the CSV header needs a "url" column');
  }

  const body = headerless ? records : records.slice(1);
  return body.map((record, i) => {
    const line = i + (headerless ? 1 : 2);
    if (record.length > header.length) {
      throw new UsageError(
        `row ${String(line)} has ${String(record.length)} fields but the header names ${String(header.length)}`,
      );
    }
    const cell = (name: string): string | undefined => {
      const at = header.indexOf(name);
      const value = at < 0 ? undefined : record[at]?.trim();
      return value === "" ? undefined : value;
    };
    const url = cell("url");
    if (!url) throw new UsageError(`row ${String(line)} has no url`);
    const row: ImportRow = { url };
    const externalId = cell("external_id");
    if (externalId !== undefined) row.externalId = externalId;
    const title = cell("title");
    if (title !== undefined) row.title = title;
    const description = cell("description");
    if (description !== undefined) row.description = description;
    const visibility = cell("visibility");
    if (visibility !== undefined) row.visibility = visibility;
    const duration = cell("duration_seconds");
    if (duration !== undefined) {
      const n = Number(duration);
      if (!Number.isFinite(n) || n <= 0) {
        throw new UsageError(`row ${String(line)}: duration_seconds must be a number above 0, got "${duration}"`);
      }
      row.durationSeconds = n;
    }
    return row;
  });
}

function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (quoted) throw new UsageError("the CSV ends inside a quoted field");
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}
