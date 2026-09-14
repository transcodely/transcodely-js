import { describe, expect, it } from "vitest";

import { deserialize } from "../src/codec/json.js";
import { GetJobResponse } from "../src/gen/transcodely/v1/job_pb.js";

function encode(json: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

const wireJob = {
  job: {
    id: "job_abc123def456",
    status: "completed",
    outputs: [
      {
        id: "out_abc123def4567",
        status: "completed",
        report: {
          container: "mp4",
          duration_seconds: 30.5,
          checked_at: "2026-09-14T10:00:00Z",
          video: {
            codec: "hevc",
            profile: "main10",
            level: "4.0",
            pix_fmt: "yuv420p10le",
            width: 1920,
            height: 1080,
            frame_rate: 29.97,
            bitrate_kbps: 4800,
            hdr_format: "hdr10",
            color: {
              primaries: "bt2020",
              transfer: "smpte2084",
              matrix: "bt2020nc",
              range: "tv",
            },
          },
          audio: [
            {
              codec: "aac",
              channels: 2,
              sample_rate_hz: 48000,
              bitrate_kbps: 128,
              language: "eng",
            },
          ],
          verdict: {
            matches_request: false,
            mismatches: [
              { field: "video.codec", expected: "h264", actual: "hevc" },
            ],
          },
        },
      },
    ],
  },
};

describe("output report", () => {
  it("decodes off the wire and answers whether the file matched the request", () => {
    const resp = deserialize(encode(wireJob), GetJobResponse);

    const outputs = resp.job?.outputs ?? [];
    expect(outputs).toHaveLength(1);

    const report = outputs[0]!.report;
    expect(report).toBeDefined();

    expect(report!.verdict?.matchesRequest).toBe(false);
    expect(report!.verdict?.mismatches).toHaveLength(1);
    expect(report!.verdict?.mismatches[0]!.field).toBe("video.codec");
    expect(report!.verdict?.mismatches[0]!.expected).toBe("h264");
    expect(report!.verdict?.mismatches[0]!.actual).toBe("hevc");

    expect(report!.container).toBe("mp4");
    expect(report!.durationSeconds).toBe(30.5);
    expect(report!.video?.codec).toBe("hevc");
    expect(report!.video?.profile).toBe("main10");
    expect(report!.video?.pixFmt).toBe("yuv420p10le");
    expect(report!.video?.width).toBe(1920);
    expect(report!.video?.height).toBe(1080);
    expect(report!.video?.hdrFormat).toBe("hdr10");
    expect(report!.video?.color?.transfer).toBe("smpte2084");
    expect(report!.audio).toHaveLength(1);
    expect(report!.audio[0]!.codec).toBe("aac");
    expect(report!.audio[0]!.sampleRateHz).toBe(48000);
  });

  it("leaves an unmeasured output's report undefined rather than empty", () => {
    const resp = deserialize(
      encode({
        job: { id: "job_abc123def456", outputs: [{ id: "out_abc123def4567" }] },
      }),
      GetJobResponse,
    );
    expect(resp.job?.outputs[0]!.report).toBeUndefined();
  });
});
