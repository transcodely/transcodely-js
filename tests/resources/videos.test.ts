import { describe, expect, it, vi } from "vitest";

import { VideoService } from "../../src/gen/transcodely/v1/video_connect.js";
import {
  CreateFromUrlResponse,
  GetStatsResponse,
  ListTopVideosResponse,
  TopVideo,
  Video,
  VideoStatsDay,
  VideoStatsTotals,
} from "../../src/gen/transcodely/v1/video_pb.js";
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
});
