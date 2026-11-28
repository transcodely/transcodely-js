/**
 * The uploaded-caption-file methods on client.videos, on the wire: URL, body
 * (snake_case, the source oneof as its set member, int64 as a JSON string),
 * and how each answer is read. Bodies are matched rather than compared whole
 * because the codec also emits unset fields at their zero value.
 */

import { describe, expect, it, vi } from "vitest";

import { Transcodely } from "../../src/client.js";
import { VideoTextTrackStatus } from "../../src/gen/transcodely/v1/video_text_track_pb.js";

const BASE = "https://example.invalid";
const url = (method: string) => `${BASE}/transcodely.v1.VideoService/${method}`;

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

function client(...answers: unknown[]): { client: Transcodely; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(u),
      body: JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(answers[sent.length - 1] ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return {
    client: new Transcodely({ apiKey: "tk_test", baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch }),
    sent,
  };
}

const TRACK = {
  id: "trk_a1b2c3d4e5f6g7",
  language: "eng",
  kind: "subtitles",
  label: "English",
  uploaded: true,
};

describe("client.videos text tracks", () => {
  it("createTextTrack from a URL sends source.url and returns the full response", async () => {
    const { client: c, sent } = client({ text_track: { ...TRACK, status: "ready", url: "https://cdn/x.vtt" } });
    const res = await c.videos.createTextTrack({
      videoId: "vid_a1b2c3d4e5f6g7",
      language: "en",
      kind: "captions",
      label: "English (CC)",
      replace: true,
      source: { source: { case: "url", value: "https://example.com/en.srt" } },
    });
    expect(sent[0]!.url).toBe(url("CreateTextTrack"));
    expect(sent[0]!.body).toMatchObject({
      video_id: "vid_a1b2c3d4e5f6g7",
      language: "en",
      kind: "captions",
      label: "English (CC)",
      replace: true,
      source: { url: "https://example.com/en.srt" },
    });
    expect(res.textTrack?.status).toBe(VideoTextTrackStatus.READY);
    expect(res.textTrack?.uploaded).toBe(true);
    expect(res.uploadUrl).toBeUndefined();
  });

  it("createTextTrack with an upload source sends size_bytes and surfaces upload_url", async () => {
    const { client: c, sent } = client({
      text_track: { ...TRACK, status: "processing" },
      upload_url: "https://storage.example/put?sig=1",
      upload_url_expires_at: "2026-11-28T11:00:00Z",
    });
    const res = await c.videos.createTextTrack({
      videoId: "vid_a1b2c3d4e5f6g7",
      language: "en",
      source: { source: { case: "upload", value: { sizeBytes: 12345n } } },
    });
    expect(sent[0]!.body).toMatchObject({ source: { upload: { size_bytes: "12345" } } });
    expect(sent[0]!.body.source).not.toHaveProperty("url");
    expect(res.textTrack?.status).toBe(VideoTextTrackStatus.PROCESSING);
    expect(res.uploadUrl).toBe("https://storage.example/put?sig=1");
    expect(res.uploadUrlExpiresAt?.toDate().toISOString()).toBe("2026-11-28T11:00:00.000Z");
  });

  it("completeTextTrackUpload names the video and track and unwraps the track", async () => {
    const { client: c, sent } = client({ text_track: { ...TRACK, status: "ready" } });
    const track = await c.videos.completeTextTrackUpload({
      videoId: "vid_a1b2c3d4e5f6g7",
      textTrackId: "trk_a1b2c3d4e5f6g7",
    });
    expect(sent[0]!.url).toBe(url("CompleteTextTrackUpload"));
    expect(sent[0]!.body).toMatchObject({ video_id: "vid_a1b2c3d4e5f6g7", text_track_id: "trk_a1b2c3d4e5f6g7" });
    expect(track.id).toBe("trk_a1b2c3d4e5f6g7");
    expect(track.status).toBe(VideoTextTrackStatus.READY);
  });

  it("deleteTextTrack returns the video with its remaining tracks", async () => {
    const { client: c, sent } = client({
      video: { id: "vid_a1b2c3d4e5f6g7", status: "ready", text_tracks: [] },
    });
    const video = await c.videos.deleteTextTrack({
      videoId: "vid_a1b2c3d4e5f6g7",
      textTrackId: "trk_a1b2c3d4e5f6g7",
    });
    expect(sent[0]!.url).toBe(url("DeleteTextTrack"));
    expect(sent[0]!.body).toMatchObject({ video_id: "vid_a1b2c3d4e5f6g7", text_track_id: "trk_a1b2c3d4e5f6g7" });
    expect(video.id).toBe("vid_a1b2c3d4e5f6g7");
    expect(video.textTracks).toEqual([]);
  });

  it("decodes a failed track's status and failure_message", async () => {
    const { client: c } = client({
      text_track: { ...TRACK, status: "failed", failure_message: "cue 3 starts before cue 2" },
    });
    const track = await c.videos.completeTextTrackUpload({
      videoId: "vid_a1b2c3d4e5f6g7",
      textTrackId: "trk_a1b2c3d4e5f6g7",
    });
    expect(track.status).toBe(VideoTextTrackStatus.FAILED);
    expect(track.failureMessage).toBe("cue 3 starts before cue 2");
  });
});
