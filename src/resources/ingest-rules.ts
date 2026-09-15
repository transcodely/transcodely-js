import type { PartialMessage } from "@bufbuild/protobuf";

import { PaginationRequest } from "../gen/transcodely/v1/common_pb.js";
import { IngestRuleService } from "../gen/transcodely/v1/ingest_rule_connect.js";
import {
  CreateIngestRuleRequest,
  type CreateIngestRuleResponse,
  DeleteIngestRuleRequest,
  GetIngestRuleRequest,
  type IngestRule,
  ListIngestEventsRequest,
  ListIngestRulesRequest,
  ReplayIngestEventRequest,
  type StorageEvent,
  TestIngestRuleRequest,
  type TestIngestRuleResponse,
  UpdateIngestRuleRequest,
  type UpdateIngestRuleResponse,
} from "../gen/transcodely/v1/ingest_rule_pb.js";

import { Page } from "../pagination.js";
import type { CallOptions, Transport } from "../transport/transport.js";

/**
 * Ingest rules — standing instructions that turn an object landing in a watched
 * bucket into a job, with no server of yours in the path.
 *
 * A rule hangs off one readable storage origin. Your provider posts its
 * object-created events to the rule's `endpointUrl`, authenticated with the
 * rule's secret; a delivery that passes the filters becomes a job. Duplicate
 * deliveries are absorbed — an object is identified by (rule, bucket, key,
 * etag) and produces exactly one job.
 *
 * The inbound endpoint itself is not part of this SDK: your storage provider
 * calls it, not you.
 */
export class IngestRules {
  constructor(private readonly transport: Transport) {}

  /**
   * Creates a rule on a readable origin. The full response is returned because
   * `secret` rides on it — the inbound secret is shown once, here, and cannot
   * be read back. Store it wherever the event sender will read it from.
   */
  create(
    req: PartialMessage<CreateIngestRuleRequest>,
    opts?: CallOptions,
  ): Promise<CreateIngestRuleResponse> {
    return this.transport.unary(
      IngestRuleService,
      IngestRuleService.methods.create,
      new CreateIngestRuleRequest(req),
      opts,
    );
  }

  /**
   * Fetches a rule by ID (`ing_*`). The secret is never returned again — the
   * rule carries only `secretPrefix` and `secretHint`.
   */
  async get(id: string, opts?: CallOptions): Promise<IngestRule> {
    const res = await this.transport.unary(
      IngestRuleService,
      IngestRuleService.methods.get,
      new GetIngestRuleRequest({ id }),
      opts,
    );
    return res.rule!;
  }

  /** Rules in scope, newest first. Narrow with `originId` or `enabled`. */
  list(req: PartialMessage<ListIngestRulesRequest> = {}, opts?: CallOptions): Page<IngestRule> {
    return new Page<IngestRule>(async (cursor) => {
      const proto = new ListIngestRulesRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        IngestRuleService,
        IngestRuleService.methods.list,
        proto,
        opts,
      );
      return { items: res.rules, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }

  /**
   * Updates name, enabled state, filters or action, and optionally rotates the
   * secret. It MERGES: an update applies only what it carries, down to the
   * individual filters and the individual parts of the action. Narrowing a
   * rule to a new prefix is `{ filters: { prefix: "raw/" } }` and nothing
   * else — the suffix, content-type and size filters are untouched.
   *
   * Removing something rather than changing it takes the two clear flags.
   * `clearFilters` empties the filter set before `filters` is applied, so on
   * its own it widens the rule to everything in the bucket. `clearAction`
   * replaces the action outright, and `action` must then be complete — at
   * least one output and exactly one destination. That is the only way to drop
   * an action's thumbnails or metadata, since a repeated or map field sent
   * empty reads as "not sent".
   *
   * For the same reason `managed: false` does not turn managed storage off; it
   * leaves the destination alone. Send `outputOriginId` instead.
   *
   * The full response is returned: a rotation puts the new secret on it (once),
   * and switching a paused rule back on reports how many deliveries it declined
   * while off in `eventsSkippedWhileDisabled`. After a rotation the previous
   * secret keeps working for 24 hours.
   */
  update(
    req: PartialMessage<UpdateIngestRuleRequest>,
    opts?: CallOptions,
  ): Promise<UpdateIngestRuleResponse> {
    return this.transport.unary(
      IngestRuleService,
      IngestRuleService.methods.update,
      new UpdateIngestRuleRequest(req),
      opts,
    );
  }

  /**
   * Deletes a rule; its endpoint stops accepting events immediately. The events
   * it already received are kept, and the rule as it stood is returned.
   */
  async delete(id: string, opts?: CallOptions): Promise<IngestRule> {
    const res = await this.transport.unary(
      IngestRuleService,
      IngestRuleService.methods.delete,
      new DeleteIngestRuleRequest({ id }),
      opts,
    );
    return res.rule!;
  }

  /**
   * Every delivery received and what came of it, newest first. Omit `ruleId`
   * for all rules in scope; set `status` to read only the skipped or failed.
   */
  listEvents(
    req: PartialMessage<ListIngestEventsRequest> = {},
    opts?: CallOptions,
  ): Page<StorageEvent> {
    return new Page<StorageEvent>(async (cursor) => {
      const proto = new ListIngestEventsRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        IngestRuleService,
        IngestRuleService.methods.listEvents,
        proto,
        opts,
      );
      return { items: res.events, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }

  /**
   * Dry-runs an object key against a rule: whether the filters match and, when
   * they do, the exact job request the rule would submit. Nothing is stored and
   * no job is created.
   *
   * Supply `etag` when you want the preview to name the idempotency key a real
   * delivery would carry — the key is derived from it.
   */
  test(
    req: PartialMessage<TestIngestRuleRequest>,
    opts?: CallOptions,
  ): Promise<TestIngestRuleResponse> {
    return this.transport.unary(
      IngestRuleService,
      IngestRuleService.methods.test,
      new TestIngestRuleRequest(req),
      opts,
    );
  }

  /**
   * Re-queues a skipped or refused event (`sev_*`), giving the object one more
   * pass through the rule.
   *
   * It exists because deduplication is permanent: re-sending the event, or
   * re-uploading the same bytes, is absorbed and produces nothing. The event is
   * reset rather than duplicated, so it keeps its id and its history.
   */
  async replayEvent(eventId: string, opts?: CallOptions): Promise<StorageEvent> {
    const res = await this.transport.unary(
      IngestRuleService,
      IngestRuleService.methods.replayEvent,
      new ReplayIngestEventRequest({ eventId }),
      opts,
    );
    return res.event!;
  }
}
