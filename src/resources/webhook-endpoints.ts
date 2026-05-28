import type { PartialMessage } from "@bufbuild/protobuf";

import { PaginationRequest } from "../gen/transcodely/v1/common_pb.js";
import { WebhookService } from "../gen/transcodely/v1/webhook_connect.js";
import {
  CreateWebhookEndpointRequest,
  DeleteWebhookEndpointRequest,
  GetEndpointHealthRequest,
  type GetEndpointHealthResponse,
  ListWebhookDeliveriesRequest,
  ListWebhookEndpointsRequest,
  RetrieveWebhookEndpointRequest,
  RotateWebhookSecretRequest,
  SendTestWebhookRequest,
  UpdateWebhookEndpointRequest,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "../gen/transcodely/v1/webhook_pb.js";
import { Page } from "../pagination.js";
import type { CallOptions, Transport } from "../transport/transport.js";

/**
 * Manage signed webhook endpoints, send synthetic test deliveries, and
 * inspect delivery history and health.
 *
 * Stripe parity: method names match the resource verbs (`create`,
 * `retrieve`, `update`, `delete`, `list`) without re-stating the
 * "Webhook" prefix already implied by the namespace.
 */
export class WebhookEndpoints {
  constructor(private readonly transport: Transport) {}

  async create(
    req: PartialMessage<CreateWebhookEndpointRequest>,
    opts?: CallOptions,
  ): Promise<WebhookEndpoint> {
    const res = await this.transport.unary(
      WebhookService,
      WebhookService.methods.createWebhookEndpoint,
      new CreateWebhookEndpointRequest(req),
      opts,
    );
    return res.endpoint!;
  }

  async retrieve(id: string, opts?: CallOptions): Promise<WebhookEndpoint> {
    const res = await this.transport.unary(
      WebhookService,
      WebhookService.methods.retrieveWebhookEndpoint,
      new RetrieveWebhookEndpointRequest({ id }),
      opts,
    );
    return res.endpoint!;
  }

  async update(
    req: PartialMessage<UpdateWebhookEndpointRequest>,
    opts?: CallOptions,
  ): Promise<WebhookEndpoint> {
    const res = await this.transport.unary(
      WebhookService,
      WebhookService.methods.updateWebhookEndpoint,
      new UpdateWebhookEndpointRequest(req),
      opts,
    );
    return res.endpoint!;
  }

  async delete(id: string, opts?: CallOptions): Promise<void> {
    await this.transport.unary(
      WebhookService,
      WebhookService.methods.deleteWebhookEndpoint,
      new DeleteWebhookEndpointRequest({ id }),
      opts,
    );
  }

  list(
    req: PartialMessage<ListWebhookEndpointsRequest>,
    opts?: CallOptions,
  ): Page<WebhookEndpoint> {
    return new Page<WebhookEndpoint>(async (cursor) => {
      const proto = new ListWebhookEndpointsRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        WebhookService,
        WebhookService.methods.listWebhookEndpoints,
        proto,
        opts,
      );
      return { items: res.endpoints, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }

  /**
   * Rotate the signing secret. The previous secret remains valid for 24 h
   * to drain in-flight deliveries. The returned endpoint includes the new
   * plain-text `secret` — this is the only response that exposes it.
   */
  async rotateSecret(id: string, opts?: CallOptions): Promise<WebhookEndpoint> {
    const res = await this.transport.unary(
      WebhookService,
      WebhookService.methods.rotateWebhookSecret,
      new RotateWebhookSecretRequest({ id }),
      opts,
    );
    return res.endpoint!;
  }

  /**
   * Send a synthetic test event to a single endpoint. The synthetic event
   * is invisible to `client.events.list` and never bumps `pending_webhooks`
   * on any other event. Rate-limited to 10/min per endpoint server-side.
   */
  async sendTest(
    endpointId: string,
    eventType: string,
    opts?: CallOptions,
  ): Promise<WebhookDelivery> {
    const res = await this.transport.unary(
      WebhookService,
      WebhookService.methods.sendTestWebhook,
      new SendTestWebhookRequest({ endpointId, eventType }),
      opts,
    );
    return res.delivery!;
  }

  /**
   * List delivery attempts. Filter by `endpointId` (deliveries for one
   * endpoint), `eventId` (deliveries for one event across all subscribers),
   * or both. At least one of the two is required server-side.
   */
  listDeliveries(
    req: PartialMessage<ListWebhookDeliveriesRequest>,
    opts?: CallOptions,
  ): Page<WebhookDelivery> {
    return new Page<WebhookDelivery>(async (cursor) => {
      const proto = new ListWebhookDeliveriesRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        WebhookService,
        WebhookService.methods.listWebhookDeliveries,
        proto,
        opts,
      );
      return { items: res.deliveries, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }

  /**
   * Aggregate delivery health for one endpoint over a rolling window.
   * Response is cached server-side for ~30 s.
   */
  async getHealth(
    endpointId: string,
    window?: "24h" | "7d" | "30d",
    opts?: CallOptions,
  ): Promise<GetEndpointHealthResponse> {
    return this.transport.unary(
      WebhookService,
      WebhookService.methods.getEndpointHealth,
      new GetEndpointHealthRequest({ endpointId, window }),
      opts,
    );
  }
}
