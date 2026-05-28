import { Timestamp } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";

import { PaginationResponse } from "../../src/gen/transcodely/v1/common_pb.js";
import { Job, JobStatus } from "../../src/gen/transcodely/v1/job_pb.js";
import { WebhookService } from "../../src/gen/transcodely/v1/webhook_connect.js";
import {
  Event as APIEvent,
  ListEventsResponse,
  ResendEventResponse,
  RetrieveEventResponse,
  WebhookDelivery,
} from "../../src/gen/transcodely/v1/webhook_pb.js";
import { Events, protoEventToSdk } from "../../src/resources/events.js";
import { Transport } from "../../src/transport/transport.js";

function makeTransport(): Transport {
  return new Transport({ apiKey: "tk_test", baseUrl: "https://example.invalid" });
}

function fakeProtoEvent(): APIEvent {
  return new APIEvent({
    id: "evt_pe1",
    appId: "app_xyz",
    type: "job.succeeded",
    data: JSON.stringify({ id: "job_inner", object: "job", status: "completed", input_url: "https://x/in.mp4" }),
    requestId: "req_pe1",
    pendingWebhooks: 0,
    createdAt: Timestamp.fromDate(new Date("2026-05-24T10:55:08Z")),
    apiVersion: "2026-05-23",
    livemode: true,
    object: "event",
  });
}

describe("Events facade", () => {
  it("retrieve bridges proto Event to SDK WebhookEvent", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary").mockResolvedValue(
      new RetrieveEventResponse({ event: fakeProtoEvent() }),
    );
    const event = await new Events(transport).retrieve("evt_pe1");
    expect(event.id).toBe("evt_pe1");
    expect(event.object).toBe("event");
    expect(event.type).toBe("job.succeeded");
    expect(event.apiVersion).toBe("2026-05-23");
    expect(event.created).toBe("2026-05-24T10:55:08.000Z");
    expect(event.livemode).toBe(true);
    expect(event.pendingWebhooks).toBe(0);
    expect(event.request).toEqual({ id: "req_pe1", idempotencyKey: null });
    expect(event.data).toBeInstanceOf(Job);
    expect((event.data as Job).id).toBe("job_inner");
    expect((event.data as Job).inputUrl).toBe("https://x/in.mp4");
    // Bridge shares the decoder, so it inherits the same enum-expansion requirement.
    expect((event.data as Job).status).toBe(JobStatus.COMPLETED);
  });

  it("list paginates with cursor passthrough and bridges each event", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValueOnce(
        new ListEventsResponse({
          events: [fakeProtoEvent()],
          pagination: new PaginationResponse({ nextCursor: "c1" }),
        }),
      )
      .mockResolvedValueOnce(
        new ListEventsResponse({
          events: [fakeProtoEvent()],
          pagination: new PaginationResponse({ nextCursor: "" }),
        }),
      );
    const all: string[] = [];
    for await (const e of new Events(transport).list({ appId: "app_xyz" }).autoPage()) {
      all.push(e.id);
      expect(e.data).toBeInstanceOf(Job);
    }
    expect(all.length).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("resend dispatches ResendEvent and returns delivery list", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValue(
        new ResendEventResponse({
          deliveries: [new WebhookDelivery({ id: "whd_re1" }), new WebhookDelivery({ id: "whd_re2" })],
        }),
      );
    const deliveries = await new Events(transport).resend("evt_pe1", {
      endpointIds: ["whe_a", "whe_b"],
    });
    expect(spy.mock.calls[0][1]).toBe(WebhookService.methods.resendEvent);
    const req = spy.mock.calls[0][2] as { id: string; endpointIds: string[] };
    expect(req.id).toBe("evt_pe1");
    expect(req.endpointIds).toEqual(["whe_a", "whe_b"]);
    expect(deliveries.map((d) => d.id)).toEqual(["whd_re1", "whd_re2"]);
  });

  it("resend without endpointIds uses default (all subscribers)", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValue(new ResendEventResponse({ deliveries: [] }));
    await new Events(transport).resend("evt_pe1");
    const req = spy.mock.calls[0][2] as { id: string; endpointIds: string[] };
    expect(req.endpointIds).toEqual([]);
  });
});

describe("protoEventToSdk bridge", () => {
  it("handles an unknown event type by leaving data as a parsed object", () => {
    const proto = new APIEvent({
      id: "evt_u",
      type: "future.unknown",
      data: JSON.stringify({ id: "ftr_x", something: "else" }),
      apiVersion: "2026-05-23",
      object: "event",
    });
    const event = protoEventToSdk(proto);
    expect(event.type).toBe("future.unknown");
    expect(event.data).toEqual({ id: "ftr_x", something: "else" });
  });

  it("returns an empty data object when proto.data is empty", () => {
    const proto = new APIEvent({
      id: "evt_empty",
      type: "job.succeeded",
      data: "",
      apiVersion: "2026-05-23",
      object: "event",
    });
    const event = protoEventToSdk(proto);
    expect(event.id).toBe("evt_empty");
    // No JSON to decode → empty object passed through Job.fromJson which
    // returns a default Job instance
    expect(event.data).toBeInstanceOf(Job);
  });

  it("missing createdAt produces an empty `created` string", () => {
    const proto = new APIEvent({
      id: "evt_no_ts",
      type: "job.succeeded",
      data: JSON.stringify({ id: "job_x" }),
      apiVersion: "2026-05-23",
      object: "event",
    });
    const event = protoEventToSdk(proto);
    expect(event.created).toBe("");
  });
});
