import { describe, expect, it } from "vitest";

import { deserialize, serialize } from "../../src/codec/json.js";
import {
  HostingConfig,
  UpdateHostingConfigRequest,
} from "../../src/gen/transcodely/v1/app_pb.js";
import { GetUsageResponse } from "../../src/gen/transcodely/v1/video_pb.js";

function decode(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

describe("delivery regions wire format", () => {
  it("serializes HostingConfig.deliveryRegions as snake_case delivery_regions", () => {
    const req = new UpdateHostingConfigRequest({
      id: "app_abc",
      hostingConfig: new HostingConfig({ deliveryRegions: ["europe"] }),
    });
    const obj = decode(serialize(req, UpdateHostingConfigRequest));
    const cfg = obj.hosting_config as Record<string, unknown>;
    expect(cfg.delivery_regions).toEqual(["europe"]);
    expect(cfg).not.toHaveProperty("deliveryRegions");
  });

  it("parses egress_by_region on a usage summary and its daily rows", () => {
    const body = JSON.stringify({
      usage: {
        egress_gb: 3,
        egress_by_region: [
          { region: "europe", egress_bytes: "2147483648", egress_gb: 2 },
          { region: "", egress_bytes: "1073741824", egress_gb: 1 },
        ],
        daily: [
          {
            date: "2026-11-01",
            egress_bytes: "3221225472",
            egress_by_region: [
              { region: "europe", egress_bytes: "2147483648" },
              { egress_bytes: "1073741824" },
            ],
          },
        ],
      },
    });
    const resp = deserialize(new TextEncoder().encode(body), GetUsageResponse);
    const by = resp.usage!.egressByRegion;
    expect(by).toHaveLength(2);
    expect(by[0]!.region).toBe("europe");
    expect(by[0]!.egressBytes).toBe(2147483648n);
    expect(by[0]!.egressGb).toBe(2);
    expect(by[1]!.region).toBe("");
    expect(resp.usage!.daily[0]!.egressByRegion[0]!.region).toBe("europe");
  });
});
