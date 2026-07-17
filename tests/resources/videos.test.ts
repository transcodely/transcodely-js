import { describe, expect, it, vi } from "vitest";

import { VideoService } from "../../src/gen/transcodely/v1/video_connect.js";
import { CreateFromUrlResponse, Video } from "../../src/gen/transcodely/v1/video_pb.js";
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
});
