import { describe, expect, it, vi } from "vitest";

import { AppService } from "../../src/gen/transcodely/v1/app_connect.js";
import {
  GetPricingRequest,
  GetPricingResponse,
  PricingEntry,
} from "../../src/gen/transcodely/v1/app_pb.js";
import { Apps } from "../../src/resources/apps.js";
import { Transport } from "../../src/transport/transport.js";

function makeTransport(): Transport {
  return new Transport({ apiKey: "tk_test", baseUrl: "https://example.invalid" });
}

describe("Apps.getPricing", () => {
  it("sends the app id and returns the entries", async () => {
    const transport = makeTransport();
    const spy = vi.spyOn(transport, "unary").mockResolvedValueOnce(
      new GetPricingResponse({
        appId: "app_abc",
        currency: "EUR",
        entries: [
          new PricingEntry({
            ruleType: "codec",
            ruleKey: "h264",
            label: "H.264",
            groupLabel: "Encoding",
            unit: "eur_per_output_minute",
            basePrice: 0.004,
            custom: true,
            listBasePrice: 0.005,
          }),
        ],
      }),
    );

    const pricing = await new Apps(transport).getPricing("app_abc");

    expect(spy).toHaveBeenCalledTimes(1);
    const [service, method, req] = spy.mock.calls[0]!;
    expect(service).toBe(AppService);
    expect(method).toBe(AppService.methods.getPricing);
    expect((req as GetPricingRequest).appId).toBe("app_abc");
    expect(pricing.currency).toBe("EUR");
    expect(pricing.entries[0]!.basePrice).toBe(0.004);
    expect(pricing.entries[0]!.custom).toBe(true);
    expect(pricing.entries[0]!.multiplier).toBeUndefined();
  });

  it("omits app_id when no id is given", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValueOnce(new GetPricingResponse({ appId: "app_default", currency: "EUR" }));

    await new Apps(transport).getPricing();

    const req = spy.mock.calls[0]![2] as GetPricingRequest;
    expect(req.appId).toBeUndefined();
    expect(req.toJson()).toEqual({});
  });
});
