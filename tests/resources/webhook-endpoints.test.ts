import { describe, expect, it, vi } from "vitest";

import { PaginationResponse } from "../../src/gen/transcodely/v1/common_pb.js";
import { WebhookService } from "../../src/gen/transcodely/v1/webhook_connect.js";
import {
  CreateWebhookEndpointResponse,
  DeleteWebhookEndpointResponse,
  GetEndpointHealthResponse,
  ListWebhookDeliveriesResponse,
  ListWebhookEndpointsResponse,
  RetrieveWebhookEndpointResponse,
  RotateWebhookSecretResponse,
  SendTestWebhookResponse,
  UpdateWebhookEndpointResponse,
  WebhookDelivery,
  WebhookEndpoint,
} from "../../src/gen/transcodely/v1/webhook_pb.js";
import { WebhookEndpoints } from "../../src/resources/webhook-endpoints.js";
import { Transport } from "../../src/transport/transport.js";

function makeTransport(): Transport {
  return new Transport({ apiKey: "tk_test", baseUrl: "https://example.invalid" });
}

function fakeEndpoint(secret?: string): WebhookEndpoint {
  return new WebhookEndpoint({
    id: "whe_abc123",
    appId: "app_xyz",
    url: "https://customer.example.com/webhooks",
    enabledEvents: ["job.succeeded"],
    status: "enabled",
    secret,
  });
}

describe("WebhookEndpoints facade", () => {
  it("create dispatches CreateWebhookEndpoint and returns the endpoint with secret", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValue(new CreateWebhookEndpointResponse({ endpoint: fakeEndpoint("whsec_new") }));
    const endpoints = new WebhookEndpoints(transport);
    const ep = await endpoints.create({
      appId: "app_xyz",
      url: "https://customer.example.com/webhooks",
      enabledEvents: ["job.succeeded"],
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(WebhookService.methods.createWebhookEndpoint);
    expect(ep.id).toBe("whe_abc123");
    expect(ep.secret).toBe("whsec_new");
  });

  it("retrieve returns the endpoint without secret", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary").mockResolvedValue(
      new RetrieveWebhookEndpointResponse({ endpoint: fakeEndpoint() }),
    );
    const ep = await new WebhookEndpoints(transport).retrieve("whe_abc123");
    expect(ep.id).toBe("whe_abc123");
    expect(ep.secret).toBeUndefined();
  });

  it("update dispatches UpdateWebhookEndpoint", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValue(new UpdateWebhookEndpointResponse({ endpoint: fakeEndpoint() }));
    await new WebhookEndpoints(transport).update({ id: "whe_abc123", status: "disabled" });
    expect(spy.mock.calls[0][1]).toBe(WebhookService.methods.updateWebhookEndpoint);
  });

  it("delete dispatches DeleteWebhookEndpoint", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValue(new DeleteWebhookEndpointResponse());
    await new WebhookEndpoints(transport).delete("whe_abc123");
    expect(spy.mock.calls[0][1]).toBe(WebhookService.methods.deleteWebhookEndpoint);
  });

  it("list paginates with cursor passthrough", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValueOnce(
        new ListWebhookEndpointsResponse({
          endpoints: [fakeEndpoint()],
          pagination: new PaginationResponse({ nextCursor: "c1" }),
        }),
      )
      .mockResolvedValueOnce(
        new ListWebhookEndpointsResponse({
          endpoints: [fakeEndpoint()],
          pagination: new PaginationResponse({ nextCursor: "" }),
        }),
      );
    const page = new WebhookEndpoints(transport).list({ appId: "app_xyz" });
    const items: string[] = [];
    for await (const ep of page.autoPage()) items.push(ep.id);
    expect(items.length).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
    // 2nd call should have cursor=c1 on the proto request
    const secondReq = spy.mock.calls[1][2] as { pagination?: { cursor?: string } };
    expect(secondReq.pagination?.cursor).toBe("c1");
  });

  it("rotateSecret returns the endpoint with a fresh secret", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary").mockResolvedValue(
      new RotateWebhookSecretResponse({ endpoint: fakeEndpoint("whsec_rotated") }),
    );
    const ep = await new WebhookEndpoints(transport).rotateSecret("whe_abc123");
    expect(ep.secret).toBe("whsec_rotated");
  });

  it("sendTest dispatches SendTestWebhook with endpoint id and event type", async () => {
    const transport = makeTransport();
    const spy = vi.spyOn(transport, "unary").mockResolvedValue(
      new SendTestWebhookResponse({ delivery: new WebhookDelivery({ id: "whd_synth" }) }),
    );
    const delivery = await new WebhookEndpoints(transport).sendTest("whe_abc123", "job.succeeded");
    expect(spy.mock.calls[0][1]).toBe(WebhookService.methods.sendTestWebhook);
    const req = spy.mock.calls[0][2] as { endpointId: string; eventType: string };
    expect(req.endpointId).toBe("whe_abc123");
    expect(req.eventType).toBe("job.succeeded");
    expect(delivery.id).toBe("whd_synth");
  });

  it("listDeliveries paginates and accepts endpointId-only or eventId-only filters", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary").mockResolvedValue(
      new ListWebhookDeliveriesResponse({
        deliveries: [new WebhookDelivery({ id: "whd_1" })],
        pagination: new PaginationResponse({ nextCursor: "" }),
      }),
    );
    const out: string[] = [];
    for await (const d of new WebhookEndpoints(transport)
      .listDeliveries({ endpointId: "whe_abc123" })
      .autoPage()) {
      out.push(d.id);
    }
    expect(out).toEqual(["whd_1"]);
  });

  it("getHealth dispatches GetEndpointHealth and accepts an optional window", async () => {
    const transport = makeTransport();
    const spy = vi.spyOn(transport, "unary").mockResolvedValue(
      new GetEndpointHealthResponse({ window: "7d", totalAttempts: 100, succeeded: 95, failed: 5 }),
    );
    const health = await new WebhookEndpoints(transport).getHealth("whe_abc123", "7d");
    expect(spy.mock.calls[0][1]).toBe(WebhookService.methods.getEndpointHealth);
    const req = spy.mock.calls[0][2] as { endpointId: string; window?: string };
    expect(req.endpointId).toBe("whe_abc123");
    expect(req.window).toBe("7d");
    expect(health.window).toBe("7d");
    expect(health.succeeded).toBe(95);
  });
});
