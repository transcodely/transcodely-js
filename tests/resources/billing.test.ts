import { describe, expect, it, vi } from "vitest";

import {
  BillingPaymentMethod,
  BillingPortalSession,
  BillingProfile,
  Budget,
  CreateBillingPortalSessionResponse,
  ExposureThresholdSource,
  GetBillingProfileResponse,
  GetBudgetResponse,
  GetInvoiceResponse,
  GetOutstandingBalanceResponse,
  GetUpcomingInvoiceResponse,
  Invoice,
  InvoiceLineItem,
  InvoiceLineType,
  InvoiceStatus,
  ListInvoicesResponse,
  OutstandingBalance,
  PaymentMethodState,
  Settlement,
  SettleOutstandingBalanceResponse,
  TrustTier,
  UpdateBudgetResponse,
} from "../../src/gen/transcodely/v1/billing_pb.js";
import { PaginationResponse } from "../../src/gen/transcodely/v1/common_pb.js";
import { Billing } from "../../src/resources/billing.js";
import { Transport } from "../../src/transport/transport.js";

function makeTransport(organizationId?: string): Transport {
  return new Transport({
    apiKey: "tk_test",
    baseUrl: "https://example.invalid",
    ...(organizationId ? { organizationId } : {}),
  });
}

describe("Billing facade", () => {
  it("listInvoices pages with cursor passthrough", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValueOnce(
        new ListInvoicesResponse({
          invoices: [new Invoice({ id: "inv_one" }), new Invoice({ id: "inv_two" })],
          pagination: new PaginationResponse({ nextCursor: "c1" }),
        }),
      )
      .mockResolvedValueOnce(
        new ListInvoicesResponse({
          invoices: [new Invoice({ id: "inv_three" })],
          pagination: new PaginationResponse({ nextCursor: "" }),
        }),
      );

    const ids: string[] = [];
    for await (const invoice of new Billing(transport).listInvoices().autoPage()) {
      ids.push(invoice.id);
    }

    expect(ids).toEqual(["inv_one", "inv_two", "inv_three"]);
    expect(spy).toHaveBeenCalledTimes(2);
    // The cursor from page one rides on the second request.
    expect(spy.mock.calls[1]![2]).toMatchObject({ pagination: { cursor: "c1" } });
  });

  it("retrieve unwraps the invoice with its line items", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary").mockResolvedValue(
      new GetInvoiceResponse({
        invoice: new Invoice({
          id: "inv_a1b2c3d4e5f6",
          object: "invoice",
          status: InvoiceStatus.OPEN,
          currency: "EUR",
          subtotalCents: 1300n,
          totalCents: 1250n,
          lineItems: [
            new InvoiceLineItem({
              id: "li_x",
              lineType: InvoiceLineType.USAGE,
              description: "Encoding — h264 1080p standard",
              amountCents: 1300n,
              dimensions: { app_id: "app_k1l2m3n4o5", codec: "h264" },
            }),
            new InvoiceLineItem({
              id: "li_y",
              lineType: InvoiceLineType.ADJUSTMENT,
              amountCents: -50n,
            }),
          ],
        }),
      }),
    );

    const invoice = await new Billing(transport).retrieve("inv_a1b2c3d4e5f6");

    expect(invoice.id).toBe("inv_a1b2c3d4e5f6");
    expect(invoice.status).toBe(InvoiceStatus.OPEN);
    // 64-bit cents surface as bigint on the generated message.
    expect(invoice.totalCents).toBe(1250n);
    expect(invoice.lineItems).toHaveLength(2);
    expect(invoice.lineItems[0]!.dimensions).toEqual({
      app_id: "app_k1l2m3n4o5",
      codec: "h264",
    });
    // The adjustment line is signed and routinely negative.
    expect(invoice.lineItems[1]!.amountCents).toBe(-50n);
  });

  it("retrieveUpcoming returns the computed draft statement, which has no id", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary").mockResolvedValue(
      new GetUpcomingInvoiceResponse({
        invoice: new Invoice({ status: InvoiceStatus.DRAFT, totalCents: 400n }),
      }),
    );

    const invoice = await new Billing(transport).retrieveUpcoming();

    expect(invoice.id).toBe("");
    expect(invoice.status).toBe(InvoiceStatus.DRAFT);
  });

  it("retrieveProfile reports on_file for a card the provider will not describe", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary").mockResolvedValue(
      new GetBillingProfileResponse({
        profile: new BillingProfile({
          object: "billing_profile",
          orgId: "org_f6g7h8i9j0",
          paymentMethodState: PaymentMethodState.ON_FILE,
          paymentMethods: [new BillingPaymentMethod({ id: "pm_1", type: "card" })],
        }),
      }),
    );

    const profile = await new Billing(transport).retrieveProfile();

    expect(profile.paymentMethodState).toBe(PaymentMethodState.ON_FILE);
    expect(profile.paymentMethods).toHaveLength(1);
    // A method with no card metadata is still chargeable — the state is the
    // signal, not the digits.
    expect(profile.paymentMethods[0]!.brand).toBeUndefined();
    expect(profile.paymentMethods[0]!.last4).toBeUndefined();
  });

  it("retrieveProfile reports none for an org that has never touched billing", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary").mockResolvedValue(
      new GetBillingProfileResponse({
        profile: new BillingProfile({ paymentMethodState: PaymentMethodState.NONE }),
      }),
    );

    const profile = await new Billing(transport).retrieveProfile();

    expect(profile.paymentMethodState).toBe(PaymentMethodState.NONE);
    expect(profile.paymentMethods).toHaveLength(0);
  });

  it("createPortalSession unwraps the provider session URL", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary").mockResolvedValue(
      new CreateBillingPortalSessionResponse({
        session: new BillingPortalSession({
          object: "billing_portal_session",
          url: "https://portal.example/session/abc",
        }),
      }),
    );

    const session = await new Billing(transport).createPortalSession();

    expect(session.url).toBe("https://portal.example/session/abc");
  });

  it("retrieveBudget returns a budget with no amount set for an org that has none", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary").mockResolvedValue(
      new GetBudgetResponse({
        budget: new Budget({
          object: "budget",
          orgId: "org_f6g7h8i9j0",
          spentEur: 41.5,
          alertSteps: [50, 80, 100],
          currency: "EUR",
        }),
      }),
    );

    const budget = await new Billing(transport).retrieveBudget();

    // No budget set: the amount and the percentage are absent, but the spend
    // it would be measured against is still reported.
    expect(budget.amountEur).toBeUndefined();
    expect(budget.usedPercent).toBeUndefined();
    expect(budget.spentEur).toBe(41.5);
    expect(budget.notifiedSteps).toEqual([]);
  });

  it("setBudget sends the amount; clearBudget omits it entirely", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValue(new UpdateBudgetResponse({ budget: new Budget({ spentEur: 12 }) }));

    const billing = new Billing(transport);
    await billing.setBudget(250);
    expect(spy.mock.calls[0]![2]).toMatchObject({ amountEur: 250 });

    await billing.clearBudget();
    // Clearing is expressed by the field being absent, not by a zero — a zero
    // would be rejected (the server requires > 0).
    expect((spy.mock.calls[1]![2] as { amountEur?: number }).amountEur).toBeUndefined();
  });

  it("updateBudget returns the recomputed budget, alerts already sent staying sent", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary").mockResolvedValue(
      new UpdateBudgetResponse({
        budget: new Budget({
          amountEur: 100,
          spentEur: 240,
          usedPercent: 240,
          alertSteps: [50, 80, 100],
          notifiedSteps: [50, 80, 100],
        }),
      }),
    );

    const budget = await new Billing(transport).updateBudget({ amountEur: 100 });

    // usedPercent is not capped at 100.
    expect(budget.usedPercent).toBe(240);
    // Raising or lowering the budget never re-arms a step already emailed.
    expect(budget.notifiedSteps).toEqual([50, 80, 100]);
  });

  it("retrieveOutstandingBalance reports the threshold, its source, and the block state", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary").mockResolvedValue(
      new GetOutstandingBalanceResponse({
        balance: new OutstandingBalance({
          object: "outstanding_balance",
          orgId: "org_f6g7h8i9j0",
          outstandingCents: 9000n,
          tier: TrustTier.NEW,
          settledPayments: 0n,
          thresholdCents: 5000n,
          thresholdSource: ExposureThresholdSource.TRUST_TIER,
          hardStopCents: 10000n,
          blocked: false,
          usedPercent: 180,
          alertSteps: [80, 100, 125, 150, 175, 200],
          notifiedSteps: [80, 100, 125, 150],
          currency: "EUR",
          settlementAvailable: true,
        }),
      }),
    );

    const balance = await new Billing(transport).retrieveOutstandingBalance();

    expect(balance.outstandingCents).toBe(9000n);
    expect(balance.tier).toBe(TrustTier.NEW);
    expect(balance.thresholdSource).toBe(ExposureThresholdSource.TRUST_TIER);
    // Past the threshold at 180% and still serving: only hardStopCents blocks.
    expect(balance.usedPercent).toBe(180);
    expect(balance.blocked).toBe(false);
    expect(balance.hardStopCents).toBe(10000n);
  });

  it("retrieveOutstandingBalance leaves threshold, hard stop and percent absent when unbounded", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary").mockResolvedValue(
      new GetOutstandingBalanceResponse({
        balance: new OutstandingBalance({
          outstandingCents: 250000n,
          tier: TrustTier.PROVEN,
          settledPayments: 7n,
          thresholdSource: ExposureThresholdSource.UNBOUNDED,
          blocked: false,
        }),
      }),
    );

    const balance = await new Billing(transport).retrieveOutstandingBalance();

    // The intended destination of the ladder: no ceiling, so nothing to be a
    // percentage of and nothing that can ever block.
    expect(balance.thresholdCents).toBeUndefined();
    expect(balance.hardStopCents).toBeUndefined();
    expect(balance.usedPercent).toBeUndefined();
    expect(balance.blocked).toBe(false);
  });

  it("settleOutstandingBalance returns the statement and the zeroed balance together", async () => {
    const transport = makeTransport();
    vi.spyOn(transport, "unary").mockResolvedValue(
      new SettleOutstandingBalanceResponse({
        settlement: new Settlement({
          object: "settlement",
          invoiceId: "inv_a1b2c3d4e5f6",
          amountCents: 9000n,
          currency: "EUR",
        }),
        balance: new OutstandingBalance({
          outstandingCents: 0n,
          blocked: false,
          notifiedSteps: [],
          settlementAvailable: true,
        }),
      }),
    );

    const res = await new Billing(transport).settleOutstandingBalance();

    // The statement is an ordinary invoice, readable through `retrieve`.
    expect(res.settlement!.invoiceId).toBe("inv_a1b2c3d4e5f6");
    expect(res.settlement!.amountCents).toBe(9000n);
    // The refreshed balance rides along so no second read is needed.
    expect(res.balance!.outstandingCents).toBe(0n);
    expect(res.balance!.blocked).toBe(false);
    expect(res.balance!.notifiedSteps).toEqual([]);
  });

  it("decodes the wire form: lowercase enums and string-encoded cents", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            balance: {
              object: "outstanding_balance",
              outstanding_cents: "9000",
              tier: "established",
              settled_payments: "2",
              threshold_cents: "5000",
              threshold_source: "trust_tier",
              hard_stop_cents: "10000",
              blocked: false,
              used_percent: 180,
              alert_steps: [80, 100, 125, 150, 175, 200],
              currency: "EUR",
              settlement_available: true,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const transport = new Transport({
      apiKey: "tk_test",
      baseUrl: "https://example.invalid",
      organizationId: "org_f6g7h8i9j0",
      fetchImpl,
    });

    const balance = await new Billing(transport).retrieveOutstandingBalance();

    // Simplified lowercase enums expand back to the generated members.
    expect(balance.tier).toBe(TrustTier.ESTABLISHED);
    expect(balance.thresholdSource).toBe(ExposureThresholdSource.TRUST_TIER);
    // 64-bit fields arrive as JSON strings and land as bigint.
    expect(balance.outstandingCents).toBe(9000n);
    expect(balance.settledPayments).toBe(2n);
    expect(balance.thresholdCents).toBe(5000n);
  });

  it("sends X-Organization-ID only when organizationId is configured", async () => {
    const capture: Array<Headers> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capture.push(init!.headers as Headers);
      return new Response(JSON.stringify({ invoice: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const withOrg = new Transport({
      apiKey: "tk_test",
      baseUrl: "https://example.invalid",
      organizationId: "org_f6g7h8i9j0",
      fetchImpl,
    });
    await new Billing(withOrg).retrieveUpcoming();
    expect(capture[0]!.get("x-organization-id")).toBe("org_f6g7h8i9j0");

    const withoutOrg = new Transport({
      apiKey: "tk_test",
      baseUrl: "https://example.invalid",
      fetchImpl,
    });
    await new Billing(withoutOrg).retrieveUpcoming();
    expect(capture[1]!.has("x-organization-id")).toBe(false);
  });
});
