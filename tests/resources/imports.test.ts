/**
 * client.imports on the wire: the URL each method posts to, the body it sends
 * (snake_case fields, lowercase enum strings), and how it reads the answer.
 * Bodies are matched, not compared whole: the codec also emits every unset
 * field at its zero value (`app_id: ""`, `tags: []`).
 */

import { describe, expect, it, vi } from "vitest";

import { Transcodely } from "../../src/client.js";
import {
  ImportItemStatus,
  ImportPauseReason,
  ImportSourceType,
  ImportStatus,
} from "../../src/gen/transcodely/v1/import_pb.js";

const BASE = "https://example.invalid";

const IMPORT = {
  object: "import",
  id: "imp_a1b2c3d4e5f6",
  app_id: "app_k1l2m3n4o5",
  status: "draft",
  source: { type: "urls" },
  defaults: { visibility: "unlisted", tags: ["imported"] },
  spent_eur: 0,
  reserved_eur: 0,
  quote: {
    item_count: 2,
    known_duration_seconds: 600,
    unknown_duration_items: 1,
    estimated_encode_eur: 1.25,
    estimated_storage_eur_per_month: 0.04,
    currency: "EUR",
    free_encode_seconds_applied: 0,
  },
  counts: { pending: 2 },
  created_at: "2026-11-28T10:00:00Z",
  updated_at: "2026-11-28T10:00:00Z",
};

interface Sent {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
}

/** A client whose fetch answers each call with the next queued body. */
function client(...answers: unknown[]): { client: Transcodely; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)) as Record<string, unknown>,
      headers: init!.headers as Headers,
    });
    return new Response(JSON.stringify(answers[sent.length - 1] ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return {
    client: new Transcodely({ apiKey: "tk_test", baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch }),
    sent,
  };
}

const url = (method: string) => `${BASE}/transcodely.v1.ImportService/${method}`;

describe("client.imports", () => {
  it("create sends the items, defaults and cap in snake_case and returns the import", async () => {
    const { client: c, sent } = client({ import: IMPORT });
    const imp = await c.imports.create({
      source: { type: ImportSourceType.URLS },
      defaults: { visibility: "unlisted", autoCaptions: true, tags: ["imported"] },
      items: [
        { url: "https://example.com/a.mp4", externalId: "a", durationSeconds: 600 },
        {
          url: "https://example.com/b.mp4",
          externalId: "b",
          textTracks: [{ url: "https://example.com/b.en.vtt", language: "en", kind: "captions" }],
        },
      ],
      maxSpendEur: 5,
    });

    expect(sent[0]!.url).toBe(url("Create"));
    expect(sent[0]!.body).toMatchObject({
      source: { type: "urls" },
      defaults: { visibility: "unlisted", auto_captions: true, tags: ["imported"] },
      items: [
        { url: "https://example.com/a.mp4", external_id: "a", duration_seconds: 600 },
        {
          url: "https://example.com/b.mp4",
          external_id: "b",
          text_tracks: [{ url: "https://example.com/b.en.vtt", language: "en", kind: "captions" }],
        },
      ],
      max_spend_eur: 5,
    });
    // A write: the SDK mints an idempotency key.
    expect(sent[0]!.headers.get("idempotency-key")).toBeTruthy();

    expect(imp.id).toBe("imp_a1b2c3d4e5f6");
    expect(imp.status).toBe(ImportStatus.DRAFT);
    expect(imp.source?.type).toBe(ImportSourceType.URLS);
    expect(imp.quote?.itemCount).toBe(2);
    expect(imp.quote?.estimatedEncodeEur).toBe(1.25);
    expect(imp.quote?.unknownDurationItems).toBe(1);
  });

  it("addItems appends to the import named by id", async () => {
    const { client: c, sent } = client({ import: IMPORT });
    await c.imports.addItems({ id: "imp_a1b2c3d4e5f6", items: [{ url: "https://example.com/c.mp4" }] });
    expect(sent[0]!.url).toBe(url("AddItems"));
    expect(sent[0]!.body).toMatchObject({ id: "imp_a1b2c3d4e5f6", items: [{ url: "https://example.com/c.mp4" }] });
  });

  it("get, pause, resume and cancel take the id and unwrap the import", async () => {
    const paused = { ...IMPORT, status: "paused", pause_reason: "manual" };
    const { client: c, sent } = client(
      { import: IMPORT },
      { import: paused },
      { import: { ...IMPORT, status: "running" } },
      { import: { ...IMPORT, status: "canceled" } },
    );
    expect((await c.imports.get("imp_a1b2c3d4e5f6")).status).toBe(ImportStatus.DRAFT);
    const p = await c.imports.pause("imp_a1b2c3d4e5f6");
    expect(p.status).toBe(ImportStatus.PAUSED);
    expect(p.pauseReason).toBe(ImportPauseReason.MANUAL);
    expect((await c.imports.resume("imp_a1b2c3d4e5f6")).status).toBe(ImportStatus.RUNNING);
    expect((await c.imports.cancel("imp_a1b2c3d4e5f6")).status).toBe(ImportStatus.CANCELED);

    expect(sent.map((s) => s.url)).toEqual([url("Get"), url("Pause"), url("Resume"), url("Cancel")]);
    for (const s of sent) expect(s.body).toMatchObject({ id: "imp_a1b2c3d4e5f6" });
    // Get is a read: no idempotency key.
    expect(sent[0]!.headers.has("idempotency-key")).toBe(false);
  });

  it("start and update send the spend cap", async () => {
    const { client: c, sent } = client(
      { import: { ...IMPORT, status: "running", max_spend_eur: 25 } },
      { import: { ...IMPORT, status: "running", max_spend_eur: 40 } },
    );
    const started = await c.imports.start({ id: "imp_a1b2c3d4e5f6", maxSpendEur: 25 });
    expect(started.maxSpendEur).toBe(25);
    const updated = await c.imports.update({ id: "imp_a1b2c3d4e5f6", maxSpendEur: 40 });
    expect(updated.maxSpendEur).toBe(40);
    expect(sent[0]!.url).toBe(url("Start"));
    expect(sent[0]!.body).toMatchObject({ id: "imp_a1b2c3d4e5f6", max_spend_eur: 25 });
    expect(sent[1]!.url).toBe(url("Update"));
    expect(sent[1]!.body).toMatchObject({ id: "imp_a1b2c3d4e5f6", max_spend_eur: 40 });
  });

  it("list filters by a lowercase status and follows the cursor", async () => {
    const { client: c, sent } = client(
      { imports: [IMPORT], pagination: { next_cursor: "cur_2" } },
      { imports: [{ ...IMPORT, id: "imp_b1b2c3d4e5f6" }], pagination: {} },
    );
    const ids: string[] = [];
    for await (const imp of c.imports.list({ status: ImportStatus.RUNNING, pagination: { limit: 1 } }).autoPage()) {
      ids.push(imp.id);
    }
    expect(ids).toEqual(["imp_a1b2c3d4e5f6", "imp_b1b2c3d4e5f6"]);
    expect(sent[0]!.url).toBe(url("List"));
    expect(sent[0]!.body).toMatchObject({ status: "running", pagination: { limit: 1 } });
    expect(sent[1]!.body).toMatchObject({ status: "running", pagination: { limit: 1, cursor: "cur_2" } });
  });

  it("listItems pages an import's items and decodes errors and warnings", async () => {
    const item = {
      id: "imi_a1b2c3d4e5f6g7",
      import_id: "imp_a1b2c3d4e5f6",
      app_id: "app_k1l2m3n4o5",
      url: "https://example.com/a.mp4",
      estimated_cost_eur: 0.6,
      created_at: "2026-11-28T10:00:00Z",
    };
    const { client: c, sent } = client(
      {
        items: [
          { ...item, status: "failed", error: { code: "input_unreachable", message: "could not fetch" } },
        ],
        pagination: { next_cursor: "cur_2" },
      },
      {
        items: [
          {
            ...item,
            id: "imi_b1b2c3d4e5f6g7",
            status: "succeeded",
            video_id: "vid_a1b2c3d4e5f6g7",
            warnings: [{ code: "text_tracks_not_ingested", message: "text tracks are not imported yet" }],
          },
        ],
        pagination: {},
      },
    );
    const items = [];
    for await (const it of c.imports.listItems({ id: "imp_a1b2c3d4e5f6", status: ImportItemStatus.FAILED }).autoPage()) {
      items.push(it);
    }
    expect(sent[0]!.url).toBe(url("ListItems"));
    expect(sent[0]!.body).toMatchObject({ id: "imp_a1b2c3d4e5f6", status: "failed" });
    expect(sent[1]!.body).toMatchObject({ id: "imp_a1b2c3d4e5f6", status: "failed", pagination: { cursor: "cur_2" } });
    expect(items.map((i) => i.status)).toEqual([ImportItemStatus.FAILED, ImportItemStatus.SUCCEEDED]);
    expect(items[0]!.error?.code).toBe("input_unreachable");
    expect(items[1]!.videoId).toBe("vid_a1b2c3d4e5f6g7");
    expect(items[1]!.warnings[0]!.code).toBe("text_tracks_not_ingested");
  });
});
