import type { PartialMessage } from "@bufbuild/protobuf";

import { BillingService } from "../gen/transcodely/v1/billing_connect.js";
import {
  type BillingPortalSession,
  type BillingProfile,
  CreateBillingPortalSessionRequest,
  GetBillingProfileRequest,
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

  /**
   * Retrieve the organization's payment standing: whether the payment provider
   * holds a chargeable method, and what it will say about it for display.
   *
   * Read-only and side-effect free — it never creates provider resources. An
   * organization that has never touched billing reports
   * `PaymentMethodState.NONE` and no payment methods.
   *
   * `paymentMethodState` is the only reliable signal. A method's `brand` and
   * `last4` are frequently absent even for a working card, because the provider
   * does not always expose card metadata; render such a method as "Card on
   * file" rather than treating the missing digits as an error.
   */
  async retrieveProfile(opts?: CallOptions): Promise<BillingProfile> {
    const res = await this.transport.unary(
      BillingService,
      BillingService.methods.getBillingProfile,
      new GetBillingProfileRequest({}),
      opts,
    );
    return res.profile!;
  }

  /**
   * Create a short-lived session for the payment provider's hosted billing
   * portal and return it. The portal is where a payment method is added or
   * replaced and where receipts live — card details never touch this SDK.
   *
   * The first call for an organization also links it to the payment provider,
   * so the returned portal is already attached to this organization's billing
   * account. Safe to call repeatedly.
   *
   * The session is single-use and expires; request a fresh one per visit rather
   * than storing the URL.
   */
  async createPortalSession(opts?: CallOptions): Promise<BillingPortalSession> {
    const res = await this.transport.unary(
      BillingService,
      BillingService.methods.createBillingPortalSession,
      new CreateBillingPortalSessionRequest({}),
      opts,
    );
    return res.session!;
  }
}
