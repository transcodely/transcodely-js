import { describe, expect, it } from "vitest";

import { fromJson, toWireJson } from "../../src/codec/json.js";
import { HostingConfig } from "../../src/gen/transcodely/v1/app_pb.js";
import { SubtitleTrack } from "../../src/gen/transcodely/v1/subtitles_pb.js";
import {
  CreateUploadRequest,
  GuidePageSetting,
  TranslateCaptionsResponse,
  Video,
  VideoTextTrack,
} from "../../src/gen/transcodely/v1/video_pb.js";

describe("guide page on the wire", () => {
  it("decodes a webhook-shaped video: guide_page present, guide_page_enabled absent", () => {
    // video.* webhook payloads never carry guide_page_enabled (the snapshot
    // does not resolve the app default); the optional stays undefined.
    const video = fromJson({ id: "vid_a1b2c3d4e5f6g7", guide_page: "on" }, Video);
    expect(video.guidePage).toBe(GuidePageSetting.ON);
    expect(video.guidePageEnabled).toBeUndefined();
    expect(video.guideUrl).toBeUndefined();
  });

  it("decodes an API-shaped video with the effective value and the URL", () => {
    const video = fromJson(
      {
        id: "vid_a1b2c3d4e5f6g7",
        guide_page: "default",
        guide_page_enabled: true,
        guide_url: "https://play.example/v/vid_a1b2c3d4e5f6g7/guide",
      },
      Video,
    );
    expect(video.guidePage).toBe(GuidePageSetting.DEFAULT);
    expect(video.guidePageEnabled).toBe(true);
    expect(video.guideUrl).toBe("https://play.example/v/vid_a1b2c3d4e5f6g7/guide");
  });

  it("encodes guide_pages_enabled on the hosting config", () => {
    expect(toWireJson(new HostingConfig({ guidePagesEnabled: true }))).toMatchObject({
      guide_pages_enabled: true,
    });
    expect(toWireJson(new HostingConfig({}))).not.toHaveProperty("guide_pages_enabled");
  });
});

describe("caption translation on the wire", () => {
  it("decodes the TranslateCaptions response", () => {
    const res = fromJson(
      {
        job_id: "job_a1b2c3d4e5f6",
        video_id: "vid_a1b2c3d4e5f6g7",
        source_language: "eng",
        target_languages: ["ger"],
        in_flight: [{ language: "spa", job_id: "job_f6e5d4c3b2a1" }],
        estimated_fee_eur: 0.36,
        insights_included: true,
      },
      TranslateCaptionsResponse,
    );
    expect(res.jobId).toBe("job_a1b2c3d4e5f6");
    expect(res.inFlight.map((f) => [f.language, f.jobId])).toEqual([["spa", "job_f6e5d4c3b2a1"]]);
    expect(res.estimatedFeeEur).toBe(0.36);
    expect(res.insightsIncluded).toBe(true);
  });

  it("round-trips translations / auto_translations / translated_from", () => {
    expect(toWireJson(new SubtitleTrack({ translations: ["ger", "spa"] }))).toMatchObject({
      translations: ["ger", "spa"],
    });
    expect(toWireJson(new CreateUploadRequest({ autoTranslations: ["ger"] }))).toMatchObject({
      auto_translations: ["ger"],
    });
    const track = fromJson({ id: "trk_a1b2c3d4e5f6g7", language: "ger", translated_from: "eng" }, VideoTextTrack);
    expect(track.translatedFrom).toBe("eng");
  });
});
