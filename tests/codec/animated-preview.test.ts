import { describe, expect, it } from "vitest";

import { deserialize, serialize } from "../../src/codec/json.js";
import {
  CreateUploadRequest,
  GetVideoResponse,
} from "../../src/gen/transcodely/v1/video_pb.js";
import {
  ThumbnailMode,
  ThumbnailSpec,
} from "../../src/gen/transcodely/v1/thumbnails_pb.js";

function decode(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

describe("animated hover-preview thumbnails (F2)", () => {
  it("serializes an animated ThumbnailSpec with snake_case fields and lowercase enum", () => {
    const spec = new ThumbnailSpec({
      mode: ThumbnailMode.ANIMATED,
      durationSeconds: 6,
      fps: 10,
      startOffsets: [1.5, 4, 9.25],
    });
    const obj = decode(serialize(spec, ThumbnailSpec));
    // Mode simplifies to the lowercase wire string.
    expect(obj.mode).toBe("animated");
    // Snake_case keys, not protojson camelCase.
    expect(obj).toHaveProperty("duration_seconds", 6);
    expect(obj).toHaveProperty("fps", 10);
    expect(obj.start_offsets).toEqual([1.5, 4, 9.25]);
    expect(obj).not.toHaveProperty("durationSeconds");
    expect(obj).not.toHaveProperty("startOffsets");
  });

  it("round-trips the animated ThumbnailSpec, expanding the enum back", () => {
    const original = new ThumbnailSpec({
      mode: ThumbnailMode.ANIMATED,
      durationSeconds: 4,
      fps: 12,
      startOffsets: [0, 2.5],
    });
    const decoded = deserialize(serialize(original, ThumbnailSpec), ThumbnailSpec);
    expect(decoded.mode).toBe(ThumbnailMode.ANIMATED);
    expect(decoded.durationSeconds).toBe(4);
    expect(decoded.fps).toBe(12);
    expect(decoded.startOffsets).toEqual([0, 2.5]);
  });

  it("serializes the CreateUpload hover_previews toggle as snake_case", () => {
    const req = new CreateUploadRequest({ filename: "clip.mp4", hoverPreviews: true });
    const obj = decode(serialize(req, CreateUploadRequest));
    expect(obj.hover_previews).toBe(true);
    expect(obj).not.toHaveProperty("hoverPreviews");
  });

  it("parses the Video hover-preview URLs from the snake_case wire form", () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        video: {
          id: "vid_abc",
          hover_preview_url: "https://cdn.example.com/p.webp",
          hover_preview_mp4_url: "https://cdn.example.com/p.mp4",
        },
      }),
    );
    const resp = deserialize(payload, GetVideoResponse);
    expect(resp.video?.hoverPreviewUrl).toBe("https://cdn.example.com/p.webp");
    expect(resp.video?.hoverPreviewMp4Url).toBe("https://cdn.example.com/p.mp4");
  });
});
