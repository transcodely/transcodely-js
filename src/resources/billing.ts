import type { PartialMessage } from "@bufbuild/protobuf";

import { BillingService } from "../gen/transcodely/v1/billing_connect.js";
import {
  GetInvoiceRequest,
  GetUpcomingInvoiceRequest,
  type Invoice,
  ListInvoicesRequest,
} from "../gen/transcodely/v1/billing_pb.js";
import { PaginationRequest } from "../gen/transcodely/v1/common_pb.js";

import { Page } from "../pagination.js";
import type { CallOptions, Transport } from "../transport/transport.js";

/**
 * An organization's billing statements — read-only.
 *
 * Unlike every other namespace, billing settles a whole organization rather
 * than a single app, so it is **not** available to API-key callers: a key is
 * scoped to one app, and there is no app-scoped subset of an invoice worth
 * serving. An API key gets a `PermissionError`.
 *
 * Reading invoices needs a dashboard session token for an organization
 * **owner**, plus the organization the request is for:
 *
 * ```ts
 * const client = new Transcodely({
 *   apiKey: sessionToken,
 *   organizationId: "org_f6g7h8i9j0",
 * });
 * const upcoming = await client.billing.retrieveUpcoming();
 * ```
 *
 * Invoices are generated automatically when a period closes. There is no API to
 * create, edit, or delete one — a statement records what happened.
 */
export class Billing {
  constructor(private readonly transport: Transport) {}

  /**
   * Page through the organization's finalized invoices, newest period first.
   *
   * Line items are omitted here; use {@link retrieve} for one invoice's
   * breakdown. A statement still being generated for a just-ended period is
   * never returned — for the period currently accruing use
   * {@link retrieveUpcoming}.
   */
  listInvoices(
    req: PartialMessage<ListInvoicesRequest> = {},
    opts?: CallOptions,
  ): Page<Invoice> {
    return new Page<Invoice>(async (cursor) => {
      const proto = new ListInvoicesRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        BillingService,
        BillingService.methods.listInvoices,
        proto,
        opts,
      );
      return { items: res.invoices, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }

  /** Retrieve one invoice by ID (`inv_*`), including its line items. */
  async retrieve(id: string, opts?: CallOptions): Promise<Invoice> {
    const res = await this.transport.unary(
      BillingService,
      BillingService.methods.getInvoice,
      new GetInvoiceRequest({ id }),
      opts,
    );
    return res.invoice!;
  }

  /**
   * Retrieve the statement for the period currently accruing.
   *
   * Computed live from settled jobs rather than stored, so its `id` is empty,
   * its status is `draft`, and its totals move as jobs finish. Jobs still
   * running are not included at any price — a job is billed only once it
   * settles.
   */
  async retrieveUpcoming(opts?: CallOptions): Promise<Invoice> {
    const res = await this.transport.unary(
      BillingService,
      BillingService.methods.getUpcomingInvoice,
      new GetUpcomingInvoiceRequest({}),
      opts,
    );
    return res.invoice!;
  }
}
