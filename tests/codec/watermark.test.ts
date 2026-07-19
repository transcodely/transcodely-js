import { describe, expect, it } from "vitest";

import { deserialize, serialize } from "../../src/codec/json.js";
import { OutputFormat } from "../../src/gen/transcodely/v1/common_pb.js";
import {
  CreateJobRequest,
  OutputSpec,
} from "../../src/gen/transcodely/v1/job_pb.js";
import {
  WatermarkAnchor,
  WatermarkConfig,
  WatermarkPixelPlacement,
} from "../../src/gen/transcodely/v1/watermark_pb.js";

function decode(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

describe("watermark wire format", () => {
  it("serializes a relative-mode watermark with snake_case fields and a lowercase anchor", () => {
    const req = new CreateJobRequest({
      inputUrl: "https://example.com/in.mp4",
      outputs: [
        new OutputSpec({
          type: OutputFormat.HLS,
          watermark: new WatermarkConfig({
            imageUrl: "https://cdn.example.com/logo.png",
            anchor: WatermarkAnchor.BOTTOM_RIGHT,
            widthPct: 15,
            marginPct: 2,
            opacity: 0.8,
          }),
        }),
      ],
    });
    const obj = decode(serialize(req, CreateJobRequest));
    const outputs = obj.outputs as Array<Record<string, unknown>>;
    const wm = outputs[0]!.watermark as Record<string, unknown>;
    expect(wm.image_url).toBe("https://cdn.example.com/logo.png");
    expect(wm.anchor).toBe("bottom_right");
    expect(wm.width_pct).toBe(15);
    expect(wm.margin_pct).toBe(2);
    expect(wm.opacity).toBe(0.8);
    // No camelCase keys must leak into the wire payload.
    expect(wm).not.toHaveProperty("imageUrl");
    expect(wm).not.toHaveProperty("widthPct");
    expect(wm).not.toHaveProperty("marginPct");
    // The verbose enum form must never reach the wire.
    expect(wm.anchor).not.toBe("WATERMARK_ANCHOR_BOTTOM_RIGHT");
  });

  it("serializes a pixel-mode watermark with snake_case x/y/width", () => {
    const req = new CreateJobRequest({
      inputUrl: "https://example.com/in.mp4",
      outputs: [
        new OutputSpec({
          type: OutputFormat.MP4,
          watermark: new WatermarkConfig({
            imageUrl: "https://cdn.example.com/logo.png",
            opacity: 1,
            pixel: new WatermarkPixelPlacement({ x: 40, y: 40, width: 240 }),
          }),
        }),
      ],
    });
    const obj = decode(serialize(req, CreateJobRequest));
    const outputs = obj.outputs as Array<Record<string, unknown>>;
    const wm = outputs[0]!.watermark as Record<string, unknown>;
    expect(wm.image_url).toBe("https://cdn.example.com/logo.png");
    const pixel = wm.pixel as Record<string, unknown>;
    expect(pixel.x).toBe(40);
    expect(pixel.y).toBe(40);
    expect(pixel.width).toBe(240);
    // Relative-mode anchor/width_pct/margin_pct are unset in pixel mode.
    expect(wm.anchor ?? undefined).toBeUndefined();
  });

  it("round-trips a relative-mode watermark, preserving the anchor enum", () => {
    const original = new CreateJobRequest({
      inputUrl: "https://example.com/in.mp4",
      outputs: [
        new OutputSpec({
          type: OutputFormat.HLS,
          watermark: new WatermarkConfig({
            imageUrl: "https://cdn.example.com/logo.webp",
            anchor: WatermarkAnchor.TOP_LEFT,
            widthPct: 12.5,
          }),
        }),
      ],
    });
    const decoded = deserialize(serialize(original, CreateJobRequest), CreateJobRequest);
    const wm = decoded.outputs[0]?.watermark;
    expect(wm?.imageUrl).toBe("https://cdn.example.com/logo.webp");
    expect(wm?.anchor).toBe(WatermarkAnchor.TOP_LEFT);
    expect(wm?.widthPct).toBe(12.5);
  });
});
