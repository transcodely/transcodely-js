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

  it("carries what the per-title search decided, when one ran", () => {
    const resp = deserialize(
      encode({
        job: {
          id: "job_abc123def456",
          outputs: [
            {
              id: "out_abc123def4567",
              report: {
                container: "mp4",
                content_aware: {
                  mode: "per_title",
                  vmaf_target: 95,
                  vmaf_achieved: 95.4,
                  crf_chosen: 24,
                },
              },
            },
          ],
        },
      }),
      GetJobResponse,
    );

    const ca = resp.job?.outputs[0]!.report?.contentAware;
    expect(ca).toBeDefined();
    expect(ca!.mode).toBe("per_title");
    expect(ca!.vmafTarget).toBe(95);
    expect(ca!.vmafAchieved).toBeCloseTo(95.4);
    expect(ca!.crfChosen).toBe(24);
  });

  it("carries the whole search curve, when the worker reported one", () => {
    const resp = deserialize(
      encode({
        job: {
          id: "job_abc123def456",
          outputs: [
            {
              id: "out_abc123def4567",
              report: {
                container: "mp4",
                content_aware: {
                  mode: "per_title",
                  vmaf_target: 93,
                  vmaf_achieved: 93.2,
                  crf_chosen: 22,
                  seed_crf: 20,
                  met_target: true,
                  probes: [
                    { crf: 20, vmaf: 96.1, bitrate_kbps: 5200 },
                    { crf: 22, vmaf: 93.2, bitrate_kbps: 4100 },
                  ],
                },
              },
            },
          ],
        },
      }),
      GetJobResponse,
    );

    const ca = resp.job?.outputs[0]!.report?.contentAware;
    expect(ca).toBeDefined();
    expect(ca!.seedCrf).toBe(20);
    expect(ca!.metTarget).toBe(true);
    expect(ca!.probes).toHaveLength(2);
    expect(ca!.probes[0]!.crf).toBe(20);
    expect(ca!.probes[0]!.vmaf).toBeCloseTo(96.1);
    expect(ca!.probes[0]!.bitrateKbps).toBe(5200);
    expect(ca!.probes[1]!.bitrateKbps).toBe(4100);
  });

  it("leaves an ordinary output's content_aware undefined", () => {
    const resp = deserialize(
      encode({
        job: {
          id: "job_abc123def456",
          outputs: [{ id: "out_abc123def4567", report: { container: "mp4" } }],
        },
      }),
      GetJobResponse,
    );
    expect(resp.job?.outputs[0]!.report?.contentAware).toBeUndefined();
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
