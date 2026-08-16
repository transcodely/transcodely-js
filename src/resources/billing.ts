import type { PartialMessage } from "@bufbuild/protobuf";

import { BillingService } from "../gen/transcodely/v1/billing_connect.js";
import {
  type BillingPortalSession,
  type BillingProfile,
  type Budget,
  CreateBillingPortalSessionRequest,
  GetBillingProfileRequest,
  GetBudgetRequest,
  GetInvoiceRequest,
  GetOutstandingBalanceRequest,
  GetUpcomingInvoiceRequest,
  type Invoice,
  ListInvoicesRequest,
  type OutstandingBalance,
  SettleOutstandingBalanceRequest,
  type SettleOutstandingBalanceResponse,
  UpdateBudgetRequest,
} from "../gen/transcodely/v1/billing_pb.js";
import { PaginationRequest } from "../gen/transcodely/v1/common_pb.js";

import { Page } from "../pagination.js";
import type { CallOptions, Transport } from "../transport/transport.js";

/**
 * An organization's money: statements, budget, and outstanding balance.
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
 * create, edit, or delete one — a statement records what happened. The two
 * writes here do not contradict that: {@link updateBudget} moves the customer's
 * own alert threshold, and {@link settleOutstandingBalance} closes the period
 * early rather than editing anything already recorded.
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

  /**
   * Retrieve the organization's monthly budget together with the spend it is
   * measured against — everything a budget card needs, in one call.
   *
   * A budget only ever **notifies**: crossing 100% sends an email and changes
   * nothing else. The hard cap is the per-app spend limit
   * (`client.apps.setSpendLimit`), which rejects new jobs at 100%.
   *
   * Always returns a budget. An organization with none set gets one with
   * `amountEur` and `usedPercent` absent and `spentEur` still populated, so the
   * current period's spend renders before a budget exists.
   */
  async retrieveBudget(opts?: CallOptions): Promise<Budget> {
    const res = await this.transport.unary(
      BillingService,
      BillingService.methods.getBudget,
      new GetBudgetRequest({}),
      opts,
    );
    return res.budget!;
  }

  /**
   * Set or clear the organization's monthly budget. Provide `amountEur` (must
   * be > 0) to set it; omit it to clear the budget and stop the alert emails.
   * {@link setBudget} and {@link clearBudget} are the ergonomic shorthands.
   *
   * The returned budget has current-period spend recomputed, so a caller that
   * just moved the number can re-render without a second request.
   */
  async updateBudget(
    req: PartialMessage<UpdateBudgetRequest> = {},
    opts?: CallOptions,
  ): Promise<Budget> {
    const res = await this.transport.unary(
      BillingService,
      BillingService.methods.updateBudget,
      new UpdateBudgetRequest(req),
      opts,
    );
    return res.budget!;
  }

  /**
   * Set the organization's monthly budget in EUR (must be > 0).
   *
   * Alert emails fire once per billing period at each of `budget.alertSteps`
   * (50%, 80%, 100% today). Raising or lowering the amount mid-period never
   * re-arms a step already listed in `budget.notifiedSteps`.
   */
  setBudget(amountEur: number, opts?: CallOptions): Promise<Budget> {
    return this.updateBudget({ amountEur }, opts);
  }

  /**
   * Clear the organization's monthly budget, turning the alert emails off —
   * omitting the optional amount is the only way to switch them off.
   */
  clearBudget(opts?: CallOptions): Promise<Budget> {
    return this.updateBudget({}, opts);
  }

  /**
   * Retrieve the organization's outstanding balance — usage accrued but not yet
   * captured onto a statement — together with the threshold it is measured
   * against.
   *
   * Distinct from {@link retrieveUpcoming}, which reports what the **current
   * period** has accrued: this is what is **unsettled**, so it also carries
   * anything an earlier period left uncaptured, and it is the number that
   * decides whether new jobs are admitted.
   *
   * Nothing is restricted as it climbs — reminder emails go out at 80%, 100%,
   * 125%, 150% and 175% and service continues past the threshold on purpose.
   * Only at `hardStopCents` (twice the threshold) are new jobs refused, with
   * error code `outstanding_balance_exceeded`; queued and running work still
   * finishes and playback keeps serving. Branch on `blocked`, which reads the
   * same numbers the admission gate reads.
   */
  async retrieveOutstandingBalance(opts?: CallOptions): Promise<OutstandingBalance> {
    const res = await this.transport.unary(
      BillingService,
      BillingService.methods.getOutstandingBalance,
      new GetOutstandingBalanceRequest({}),
      opts,
    );
    return res.balance!;
  }

  /**
   * Pay the outstanding balance now, without waiting for the period to end.
   *
   * Closes the current period at this instant and produces a real statement —
   * an ordinary invoice, readable through {@link retrieve} — which the payment
   * provider then charges. On success the balance is zero and any admission
   * block is lifted immediately; the response carries the refreshed balance too,
   * so no follow-up read is needed.
   *
   * Takes no amount on purpose: the figure is whatever the ledger says at the
   * instant it runs, so a stale page cannot underpay and leave the difference
   * looking settled.
   *
   * Throws {@link PreconditionError} with code `settlement_unavailable` when the
   * deployment has mid-cycle settlement switched off — check
   * `balance.settlementAvailable` before offering a "pay now" action — and with
   * `nothing_outstanding` when there is nothing to pay.
   */
  settleOutstandingBalance(opts?: CallOptions): Promise<SettleOutstandingBalanceResponse> {
    return this.transport.unary(
      BillingService,
      BillingService.methods.settleOutstandingBalance,
      new SettleOutstandingBalanceRequest({}),
      opts,
    );
  }
}
