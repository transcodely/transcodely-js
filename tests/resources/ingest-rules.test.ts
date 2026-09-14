import { describe, expect, it, vi } from "vitest";

import { deserialize } from "../../src/codec/json.js";
import { PaginationResponse } from "../../src/gen/transcodely/v1/common_pb.js";
import { IngestRuleService } from "../../src/gen/transcodely/v1/ingest_rule_connect.js";
import {
  CreateIngestRuleResponse,
  DeleteIngestRuleResponse,
  GetIngestRuleResponse,
  IngestRule,
  ListIngestEventsResponse,
  ListIngestRulesResponse,
  ReplayIngestEventResponse,
  StorageEvent,
  StorageEventSource,
  StorageEventStatus,
  TestIngestRuleResponse,
  UpdateIngestRuleResponse,
} from "../../src/gen/transcodely/v1/ingest_rule_pb.js";
import { IngestRules } from "../../src/resources/ingest-rules.js";
import { Transport } from "../../src/transport/transport.js";

function makeTransport(): Transport {
  return new Transport({ apiKey: "tk_test", baseUrl: "https://example.invalid" });
}

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

describe("IngestRule wire decoding", () => {
  it("decodes a create response, snake_case, with the reveal-once secret", () => {
    const res = deserialize(
      encode({
        rule: {
          id: "ing_a1b2c3d4e5f6",
          app_id: "app_k1l2m3n4o5",
          origin_id: "ori_a1b2c3d4e5f6",
          name: "Watch uploads/",
          enabled: true,
          filters: {
            prefix: "uploads/",
            suffixes: [".mp4", ".mov"],
            min_bytes: 1024,
            max_bytes: 0,
          },
          action: {
            managed: true,
            priority: "standard",
            output_path_template: "{input_dir}/{input_name}/{resolution}",
          },
          endpoint_url: "https://api.transcodely.com/ingest/ing_a1b2c3d4e5f6",
          secret_prefix: "ings_a1b",
          secret_hint: "z9y8",
          events_received: 0,
          jobs_created: 0,
          created_at: "2026-09-14T10:00:00Z",
          updated_at: "2026-09-14T10:00:00Z",
        },
        secret: "ings_a1b2c3d4e5f6g7h8i9j0z9y8",
      }),
      CreateIngestRuleResponse,
    );

    expect(res.secret).toBe("ings_a1b2c3d4e5f6g7h8i9j0z9y8");
    expect(res.rule?.id).toBe("ing_a1b2c3d4e5f6");
    expect(res.rule?.endpointUrl).toBe("https://api.transcodely.com/ingest/ing_a1b2c3d4e5f6");
    expect(res.rule?.secretPrefix).toBe("ings_a1b");
    expect(res.rule?.secretHint).toBe("z9y8");
    expect(res.rule?.filters?.prefix).toBe("uploads/");
    expect(res.rule?.filters?.suffixes).toEqual([".mp4", ".mov"]);
    expect(res.rule?.filters?.minBytes).toBe(1024n);
    expect(res.rule?.action?.managed).toBe(true);
    expect(res.rule?.action?.outputPathTemplate).toBe("{input_dir}/{input_name}/{resolution}");
  });

  it("a read of the same rule carries no secret at all", () => {
    const res = deserialize(
      encode({
        rule: {
          id: "ing_a1b2c3d4e5f6",
          app_id: "app_k1l2m3n4o5",
          origin_id: "ori_a1b2c3d4e5f6",
          name: "Watch uploads/",
          enabled: true,
          secret_prefix: "ings_a1b",
          secret_hint: "z9y8",
          events_received: 42,
          jobs_created: 40,
          last_event_at: "2026-09-14T11:00:00Z",
          created_at: "2026-09-14T10:00:00Z",
          updated_at: "2026-09-14T10:00:00Z",
        },
      }),
      GetIngestRuleResponse,
    );

    expect(res.rule?.eventsReceived).toBe(42n);
    expect(res.rule?.jobsCreated).toBe(40n);
    expect(res.rule?.lastEventAt).toBeDefined();
    expect(res.rule?.secretRotatedAt).toBeUndefined();
    // The message has no `secret` field: the full value rides on create (and on
    // a rotation) and nowhere else.
    expect(IngestRule.fields.find("secret")).toBeUndefined();
  });

  it("decodes the event log with lowercase source and status", () => {
    const res = deserialize(
      encode({
        events: [
          {
            id: "sev_a1b2c3d4e5f6g7",
            rule_id: "ing_a1b2c3d4e5f6",
            app_id: "app_k1l2m3n4o5",
            bucket: "my-uploads",
            object_key: "uploads/my clip.mp4",
            etag: "d41d8cd98f00b204",
            size_bytes: 10485760,
            content_type: "video/mp4",
            source: "s3_sns",
            status: "created",
            job_id: "job_a1b2c3d4e5f6",
            received_at: "2026-09-14T11:00:00Z",
            processed_at: "2026-09-14T11:00:02Z",
          },
          {
            id: "sev_b2c3d4e5f6g7h8",
            rule_id: "ing_a1b2c3d4e5f6",
            app_id: "app_k1l2m3n4o5",
            bucket: "my-uploads",
            object_key: "uploads/notes.txt",
            source: "gcs_pubsub",
            status: "skipped",
            reason: "filter_suffix",
            received_at: "2026-09-14T11:05:00Z",
            processed_at: "2026-09-14T11:05:00Z",
          },
        ],
        pagination: { next_cursor: "" },
      }),
      ListIngestEventsResponse,
    );

    expect(res.events).toHaveLength(2);
    expect(res.events[0].source).toBe(StorageEventSource.S3_SNS);
    expect(res.events[0].status).toBe(StorageEventStatus.CREATED);
    // Stored URL-decoded: S3 writes a space as "+".
    expect(res.events[0].objectKey).toBe("uploads/my clip.mp4");
    expect(res.events[0].jobId).toBe("job_a1b2c3d4e5f6");

    expect(res.events[1].source).toBe(StorageEventSource.GCS_PUBSUB);
    expect(res.events[1].status).toBe(StorageEventStatus.SKIPPED);
    expect(res.events[1].reason).toBe("filter_suffix");
    expect(res.events[1].jobId).toBe("");
  });
});

describe("IngestRules facade", () => {
  it("exposes a method for every RPC on the generated service", () => {
    const rpcs = Object.keys(IngestRuleService.methods).sort();
    const facade = Object.getOwnPropertyNames(IngestRules.prototype)
      .filter((n) => n !== "constructor")
      .sort();
    expect(facade).toEqual(rpcs);
  });

  it("create returns the whole response so the reveal-once secret is reachable", async () => {
    const transport = makeTransport();
    const spy = vi.spyOn(transport, "unary").mockResolvedValue(
      new CreateIngestRuleResponse({
        rule: new IngestRule({ id: "ing_a1b2c3d4e5f6", secretPrefix: "ings_a1b" }),
        secret: "ings_full_secret_value",
      }),
    );

    const res = await new IngestRules(transport).create({
      originId: "ori_a1b2c3d4e5f6",
      name: "Watch uploads/",
      action: { managed: true },
    });

    expect(spy.mock.calls[0][1]).toBe(IngestRuleService.methods.create);
    expect(res.secret).toBe("ings_full_secret_value");
    expect(res.rule?.id).toBe("ing_a1b2c3d4e5f6");
  });

  it("update surfaces the rotated secret and the backlog an un-pause exposes", async () => {
    const transport = makeTransport();
    const spy = vi.spyOn(transport, "unary").mockResolvedValue(
      new UpdateIngestRuleResponse({
        rule: new IngestRule({ id: "ing_a1b2c3d4e5f6", enabled: true }),
        secret: "ings_rotated_secret",
        eventsSkippedWhileDisabled: 7n,
      }),
    );

    const res = await new IngestRules(transport).update({
      id: "ing_a1b2c3d4e5f6",
      enabled: true,
      rotateSecret: true,
    });

    expect(spy.mock.calls[0][1]).toBe(IngestRuleService.methods.update);
    expect(res.secret).toBe("ings_rotated_secret");
    expect(res.eventsSkippedWhileDisabled).toBe(7n);
  });

  it("get, delete and replayEvent unwrap to the bare message", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValueOnce(
        new GetIngestRuleResponse({ rule: new IngestRule({ id: "ing_a1b2c3d4e5f6" }) }),
      )
      .mockResolvedValueOnce(
        new DeleteIngestRuleResponse({ rule: new IngestRule({ id: "ing_a1b2c3d4e5f6" }) }),
      )
      .mockResolvedValueOnce(
        new ReplayIngestEventResponse({
          event: new StorageEvent({
            id: "sev_a1b2c3d4e5f6g7",
            status: StorageEventStatus.RECEIVED,
          }),
        }),
      );

    const rules = new IngestRules(transport);
    expect((await rules.get("ing_a1b2c3d4e5f6")).id).toBe("ing_a1b2c3d4e5f6");
    expect((await rules.delete("ing_a1b2c3d4e5f6")).id).toBe("ing_a1b2c3d4e5f6");

    const replayed = await rules.replayEvent("sev_a1b2c3d4e5f6g7");
    expect(replayed.status).toBe(StorageEventStatus.RECEIVED);
    expect(spy.mock.calls[2][1]).toBe(IngestRuleService.methods.replayEvent);
    expect(spy.mock.calls[2][2].toJson()).toMatchObject({ eventId: "sev_a1b2c3d4e5f6g7" });
  });

  it("list and listEvents page through the cursor", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary")
      .mockResolvedValueOnce(
        new ListIngestRulesResponse({
          rules: [new IngestRule({ id: "ing_page1" })],
          pagination: new PaginationResponse({ nextCursor: "cur1" }),
        }),
      )
      .mockResolvedValueOnce(
        new ListIngestRulesResponse({
          rules: [new IngestRule({ id: "ing_page2" })],
          pagination: new PaginationResponse({ nextCursor: "" }),
        }),
      );

    const seen: string[] = [];
    for await (const rule of new IngestRules(transport).list({}).autoPage()) {
      seen.push(rule.id);
    }
    expect(seen).toEqual(["ing_page1", "ing_page2"]);
  });

  it("test dispatches the dry run and returns the predicted job request", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValue(new TestIngestRuleResponse({ matched: false, reason: "filter_prefix" }));

    const res = await new IngestRules(transport).test({
      id: "ing_a1b2c3d4e5f6",
      objectKey: "other/clip.mp4",
    });

    expect(spy.mock.calls[0][1]).toBe(IngestRuleService.methods.test);
    expect(res.matched).toBe(false);
    expect(res.reason).toBe("filter_prefix");
    expect(res.jobRequest).toBeUndefined();
  });
});
