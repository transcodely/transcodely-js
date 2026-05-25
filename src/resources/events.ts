import type { PartialMessage } from "@bufbuild/protobuf";

import { PaginationRequest } from "../gen/transcodely/v1/common_pb.js";
import { WebhookService } from "../gen/transcodely/v1/webhook_connect.js";
import {
  type Event as APIEvent,
  ListEventsRequest,
  ResendEventRequest,
  RetrieveEventRequest,
  type WebhookDelivery,
} from "../gen/transcodely/v1/webhook_pb.js";
import { Page } from "../pagination.js";
import type { CallOptions, Transport } from "../transport/transport.js";
import { decoderForType, type WebhookEvent } from "../webhooks/types.js";

/**
 * Query and replay events. Each event the SDK hands back is the same
 * unified {@link WebhookEvent} shape that `client.webhooks.constructEvent`
 * produces — so a `job.succeeded` handler can be tested against an event
 * pulled from `client.events.retrieve(...)` and behave identically.
 *
 * The bridge from the proto-shape `Event` (which carries the inner
 * resource as a JSON string) to the SDK-shape `WebhookEvent` lives in
 * {@link protoEventToSdk}.
 */
export class Events {
  constructor(private readonly transport: Transport) {}

  async retrieve(id: string, opts?: CallOptions): Promise<WebhookEvent> {
    const res = await this.transport.unary(
      WebhookService,
      WebhookService.methods.retrieveEvent,
      new RetrieveEventRequest({ id }),
      opts,
    );
    return protoEventToSdk(res.event!);
  }

  list(req: PartialMessage<ListEventsRequest>, opts?: CallOptions): Page<WebhookEvent> {
    return new Page<WebhookEvent>(async (cursor) => {
      const proto = new ListEventsRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        WebhookService,
        WebhookService.methods.listEvents,
        proto,
        opts,
      );
      return {
        items: res.events.map(protoEventToSdk),
        nextCursor: res.pagination?.nextCursor || undefined,
      };
    });
  }

  /**
   * Resend an existing event. Creates new pending delivery records — one
   * per target endpoint — which the delivery worker picks up immediately.
   * If `endpointIds` is omitted, resends to every currently-subscribed
   * enabled endpoint.
   */
  async resend(
    id: string,
    opts: { endpointIds?: string[] } & CallOptions = {},
  ): Promise<WebhookDelivery[]> {
    const { endpointIds, ...callOpts } = opts;
    const res = await this.transport.unary(
      WebhookService,
      WebhookService.methods.resendEvent,
      new ResendEventRequest({ id, endpointIds }),
      callOpts,
    );
    return res.deliveries;
  }
}

/**
 * Bridge: proto `Event` (`data: string`, `request_id: string`, `created_at:
 * Timestamp`) → SDK `WebhookEvent` (`data: Job|Video|App|…`, `request: {id,
 * idempotencyKey}`, `created: string`). Used by `retrieve` and `list`.
 *
 * Exported for the facade tests; not re-exported from the package root.
 */
export function protoEventToSdk(proto: APIEvent): WebhookEvent {
  let parsedData: unknown = {};
  if (proto.data) {
    try {
      parsedData = JSON.parse(proto.data);
    } catch {
      // Server-controlled; if it ever fails leave the placeholder so the
      // event still surfaces (the consumer can inspect proto.data via the
      // raw APIEvent type if they need to debug a malformed payload).
    }
  }
  const decode = decoderForType(proto.type);
  const data = decode && parsedData && typeof parsedData === "object" ? decode(parsedData) : parsedData;

  return {
    id: proto.id,
    object: "event",
    apiVersion: proto.apiVersion,
    created: proto.createdAt ? proto.createdAt.toDate().toISOString() : "",
    type: proto.type,
    data,
    livemode: proto.livemode,
    pendingWebhooks: proto.pendingWebhooks,
    // proto Event carries only `request_id`; `idempotency_key` is always
    // null until JobService.Create propagates it (out-of-scope feature).
    request: { id: proto.requestId ?? "", idempotencyKey: null },
  } as WebhookEvent;
}
