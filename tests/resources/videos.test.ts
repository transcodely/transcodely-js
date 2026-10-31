import { describe, expect, it, vi } from "vitest";

import { VideoService } from "../../src/gen/transcodely/v1/video_connect.js";
import {
  CreateFromUrlResponse,
  GenerateHighlightsRequest,
  GenerateHighlightsResponse,
  GenerateInsightsRequest,
  GenerateInsightsResponse,
  GetSeoMarkupResponse,
  GetStatsResponse,
  ListTopVideosResponse,
  TopVideo,
  Video,
  VideoHighlight,
  VideoHighlightStatus,
  VideoStatsDay,
  VideoStatsTotals,
} from "../../src/gen/transcodely/v1/video_pb.js";
import {
  InsightsSource,
  InsightsStatus,
  TranscriptInsights,
} from "../../src/gen/transcodely/v1/subtitles_pb.js";
import { toWireJson } from "../../src/codec/json.js";
import { Videos } from "../../src/resources/videos.js";
import { Transport } from "../../src/transport/transport.js";

function makeTransport(): Transport {
  return new Transport({ apiKey: "tk_test", baseUrl: "https://example.invalid" });
}

function fakeVideo(overrides: Partial<Video> = {}): Video {
  return new Video({
    id: "vid_a1b2c3d4e5f6g7",
    appId: "app_xyz",
    source: "upload",
    status: "processing",
    visibility: "unlisted",
    ...overrides,
  });
}

describe("Videos facade", () => {
  it("createFromUrl dispatches CreateFromUrl and returns the video", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValue(new CreateFromUrlResponse({ video: fakeVideo() }));
    const video = await new Videos(transport).createFromUrl({
      appId: "app_xyz",
      url: "https://example.com/source.mp4",
      title: "My video",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(VideoService.methods.createFromUrl);
    const req = spy.mock.calls[0][2] as { appId: string; url: string; title?: string };
    expect(req.appId).toBe("app_xyz");
    expect(req.url).toBe("https://example.com/source.mp4");
    expect(req.title).toBe("My video");
    expect(video).toBeInstanceOf(Video);
    expect(video.id).toBe("vid_a1b2c3d4e5f6g7");
    expect(video.status).toBe("processing");
  });

  it("createFromUrl accepts only the required fields (appId, url)", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValue(new CreateFromUrlResponse({ video: fakeVideo() }));
    await new Videos(transport).createFromUrl({
      appId: "app_xyz",
      url: "https://example.com/source.mp4",
    });
    const req = spy.mock.calls[0][2] as { title?: string; description?: string };
    expect(req.title).toBeUndefined();
    expect(req.description).toBeUndefined();
  });

  it("getStats dispatches GetStats and returns the full response (daily + totals)", async () => {
    const transport = makeTransport();
    const res = new GetStatsResponse({
      daily: [
        new VideoStatsDay({ date: "2026-07-01", plays: 3, watchSeconds: 120n, uniqueViewers: 2 }),
      ],
      totals: new VideoStatsTotals({ plays: 3, watchSeconds: 120n, uniqueViewers: 2 }),
    });
    const spy = vi.spyOn(transport, "unary").mockResolvedValue(res);
    const out = await new Videos(transport).getStats({
      videoId: "vid_a1b2c3d4e5f6g7",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(VideoService.methods.getStats);
    const req = spy.mock.calls[0][2] as {
      videoId: string;
      startDate?: string;
      endDate?: string;
    };
    expect(req.videoId).toBe("vid_a1b2c3d4e5f6g7");
    expect(req.startDate).toBe("2026-07-01");
    expect(req.endDate).toBe("2026-07-31");
    // Full response is returned, not unwrapped.
    expect(out).toBeInstanceOf(GetStatsResponse);
    expect(out.daily).toHaveLength(1);
    expect(out.daily[0].date).toBe("2026-07-01");
    expect(out.totals?.plays).toBe(3);
  });

  it("listTopVideos dispatches ListTopVideos and returns the full response (items)", async () => {
    const transport = makeTransport();
    const res = new ListTopVideosResponse({
      items: [
        new TopVideo({ videoId: "vid_a1b2c3d4e5f6g7", title: "Top", plays: 42n, watchSeconds: 900n }),
      ],
    });
    const spy = vi.spyOn(transport, "unary").mockResolvedValue(res);
    const out = await new Videos(transport).listTopVideos({ appId: "app_xyz", limit: 5 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(VideoService.methods.listTopVideos);
    const req = spy.mock.calls[0][2] as { appId?: string; limit?: number };
    expect(req.appId).toBe("app_xyz");
    expect(req.limit).toBe(5);
    // Full response is returned, not unwrapped.
    expect(out).toBeInstanceOf(ListTopVideosResponse);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].videoId).toBe("vid_a1b2c3d4e5f6g7");
    expect(out.items[0].plays).toBe(42n);
  });

  it("listTopVideos can be called with no arguments (all fields optional)", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValue(new ListTopVideosResponse({ items: [] }));
    await new Videos(transport).listTopVideos();
    expect(spy).toHaveBeenCalledTimes(1);
    const req = spy.mock.calls[0][2] as { appId?: string; limit?: number };
    expect(req.appId).toBeUndefined();
    expect(req.limit).toBeUndefined();
  });

  it("getSeoMarkup dispatches GetSeoMarkup and returns the full response", async () => {
    const transport = makeTransport();
    const res = new GetSeoMarkupResponse({
      jsonLd: '{"@type":"VideoObject"}',
      sitemapEntry: "<url><loc>https://example.com/watch/42</loc></url>",
      htmlFragment: '<section class="tx-insights"></section>',
    });
    const spy = vi.spyOn(transport, "unary").mockResolvedValue(res);
    const out = await new Videos(transport).getSeoMarkup({
      videoId: "vid_a1b2c3d4e5f6g7",
      watchUrl: "https://example.com/watch/42",
      deepLinkParam: "start",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(VideoService.methods.getSeoMarkup);
    const req = spy.mock.calls[0][2] as {
      videoId: string;
      watchUrl: string;
      deepLinkParam?: string;
      language?: string;
    };
    expect(req.videoId).toBe("vid_a1b2c3d4e5f6g7");
    expect(req.watchUrl).toBe("https://example.com/watch/42");
    expect(req.deepLinkParam).toBe("start");
    expect(req.language).toBeUndefined();
    expect(out).toBeInstanceOf(GetSeoMarkupResponse);
    expect(out.jsonLd).toBe('{"@type":"VideoObject"}');
    expect(out.htmlFragment).toContain("tx-insights");
  });

  it("generateInsights dispatches GenerateInsights and returns the insights entry", async () => {
    const transport = makeTransport();
    const spy = vi.spyOn(transport, "unary").mockResolvedValue(
      new GenerateInsightsResponse({
        insights: new TranscriptInsights({
          id: "ins_abc123",
          source: InsightsSource.VIDEO,
          videoId: "vid_a1b2c3d4e5f6g7",
          language: "eng",
          status: InsightsStatus.PENDING,
        }),
      }),
    );
    const out = await new Videos(transport).generateInsights({
      id: "vid_a1b2c3d4e5f6g7",
      language: "eng",
      hint: "A cooking show for beginners",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(VideoService.methods.generateInsights);
    const req = spy.mock.calls[0][2] as {
      id: string;
      language?: string;
      hint?: string;
      appId?: string;
    };
    expect(req.id).toBe("vid_a1b2c3d4e5f6g7");
    expect(req.language).toBe("eng");
    expect(req.hint).toBe("A cooking show for beginners");
    expect(req.appId).toBeUndefined();
    expect(out).toBeInstanceOf(TranscriptInsights);
    expect(out.id).toBe("ins_abc123");
    expect(out.source).toBe(InsightsSource.VIDEO);
    expect(out.status).toBe(InsightsStatus.PENDING);
  });

  it("generateInsights sends snake_case fields on the wire", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValue(new GenerateInsightsResponse({ insights: new TranscriptInsights() }));
    await new Videos(transport).generateInsights({ id: "vid_a1b2c3d4e5f6g7", appId: "app_xyz" });
    const wire = toWireJson(spy.mock.calls[0][2] as GenerateInsightsRequest) as Record<string, unknown>;
    expect(wire).toEqual({ id: "vid_a1b2c3d4e5f6g7", app_id: "app_xyz" });
  });

  it("generateHighlights dispatches GenerateHighlights and returns the highlights", async () => {
    const transport = makeTransport();
    const spy = vi.spyOn(transport, "unary").mockResolvedValue(
      new GenerateHighlightsResponse({
        highlights: [
          new VideoHighlight({ id: "hl_a1b2c3d4e5f6g7", startSeconds: 18.5, endSeconds: 31.5, status: VideoHighlightStatus.PENDING }),
        ],
      }),
    );
    const out = await new Videos(transport).generateHighlights({ id: "vid_a1b2c3d4e5f6g7", config: { maxCount: 3 } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(VideoService.methods.generateHighlights);
    expect(out).toHaveLength(1);
    expect(out[0]).toBeInstanceOf(VideoHighlight);
    expect(out[0].id).toBe("hl_a1b2c3d4e5f6g7");
    expect(out[0].status).toBe(VideoHighlightStatus.PENDING);
  });

  it("generateHighlights sends snake_case fields on the wire", async () => {
    const transport = makeTransport();
    const spy = vi.spyOn(transport, "unary").mockResolvedValue(new GenerateHighlightsResponse());
    await new Videos(transport).generateHighlights({
      id: "vid_a1b2c3d4e5f6g7",
      language: "eng",
      config: { maxCount: 3, paddingSeconds: 2 },
    });
    const wire = toWireJson(spy.mock.calls[0][2] as GenerateHighlightsRequest) as Record<string, unknown>;
    // The codec emits unpopulated scalars, so `enabled` rides as false; the
    // server ignores it on GenerateHighlights. Unset optionals stay off.
    expect(wire).toEqual({
      id: "vid_a1b2c3d4e5f6g7",
      language: "eng",
      config: { enabled: false, max_count: 3, padding_seconds: 2 },
    });
  });
});
