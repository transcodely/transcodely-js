import { describe, expect, it, vi } from "vitest";

import {
  BillingPaymentMethod,
  BillingPortalSession,
  BillingProfile,
  CreateBillingPortalSessionResponse,
  GetBillingProfileResponse,
  GetInvoiceResponse,
  GetUpcomingInvoiceResponse,
  Invoice,
  InvoiceLineItem,
  InvoiceLineType,
  InvoiceStatus,
  ListInvoicesResponse,
  PaymentMethodState,
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
