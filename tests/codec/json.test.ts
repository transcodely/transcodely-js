import { describe, expect, it } from "vitest";

import { deserialize, serialize } from "../../src/codec/json.js";
import {
  OutputFormat,
  Resolution,
  VideoCodec,
} from "../../src/gen/transcodely/v1/common_pb.js";
import {
  CreateJobRequest,
  GetJobResponse,
  JobPriority,
  JobStatus,
  OutputSpec,
  VideoVariant,
} from "../../src/gen/transcodely/v1/job_pb.js";

function decode(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

describe("serialize", () => {
  it("emits snake_case fields", () => {
    const req = new CreateJobRequest({ inputUrl: "https://example.com/in.mp4" });
    const obj = decode(serialize(req, CreateJobRequest));
    expect(obj).toHaveProperty("input_url", "https://example.com/in.mp4");
    expect(obj).not.toHaveProperty("inputUrl");
  });

  it("simplifies enum values throughout the message tree", () => {
    const req = new CreateJobRequest({
      inputUrl: "https://example.com/in.mp4",
      priority: JobPriority.PREMIUM,
      outputs: [
        new OutputSpec({
          type: OutputFormat.HLS,
          video: [
            new VideoVariant({
              codec: VideoCodec.H264,
              resolution: Resolution.RESOLUTION_1080P,
            }),
          ],
        }),
      ],
    });
    const obj = decode(serialize(req, CreateJobRequest));
    expect(obj.priority).toBe("premium");
    const outputs = obj.outputs as Array<Record<string, unknown>>;
    expect(outputs[0]!.type).toBe("hls");
    const video = outputs[0]!.video as Array<Record<string, unknown>>;
    expect(video[0]!.codec).toBe("h264");
    expect(video[0]!.resolution).toBe("1080p");
  });
});

describe("deserialize", () => {
  it("expands simplified enums into the right proto integer", () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        job: { id: "job_a", status: "processing", priority: "premium" },
      }),
    );
    const resp = deserialize(payload, GetJobResponse);
    expect(resp.job?.id).toBe("job_a");
    expect(resp.job?.status).toBe(JobStatus.PROCESSING);
    expect(resp.job?.priority).toBe(JobPriority.PREMIUM);
  });

  it("accepts the verbose canonical enum form for backward compatibility", () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ job: { id: "job_a", status: "JOB_STATUS_PROCESSING" } }),
    );
    const resp = deserialize(payload, GetJobResponse);
    expect(resp.job?.status).toBe(JobStatus.PROCESSING);
  });

  it("returns an empty message for empty bytes", () => {
    const resp = deserialize(new Uint8Array(0), GetJobResponse);
    expect(resp.job).toBeUndefined();
  });

  it("ignores unknown fields rather than throwing", () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ job: { id: "job_a" }, made_up_field: 42 }),
    );
    const resp = deserialize(payload, GetJobResponse);
    expect(resp.job?.id).toBe("job_a");
  });
});

describe("round-trip", () => {
  it("preserves enum values and nested structure across serialize → deserialize", () => {
    const original = new CreateJobRequest({
      inputUrl: "https://example.com/in.mp4",
      outputs: [
        new OutputSpec({
          type: OutputFormat.DASH,
          video: [
            new VideoVariant({
              codec: VideoCodec.AV1,
              resolution: Resolution.RESOLUTION_2160P,
            }),
          ],
        }),
      ],
    });
    const bytes = serialize(original, CreateJobRequest);
    const decoded = deserialize(bytes, CreateJobRequest);
    expect(decoded.inputUrl).toBe(original.inputUrl);
    expect(decoded.outputs[0]?.type).toBe(OutputFormat.DASH);
    expect(decoded.outputs[0]?.video[0]?.codec).toBe(VideoCodec.AV1);
    expect(decoded.outputs[0]?.video[0]?.resolution).toBe(Resolution.RESOLUTION_2160P);
  });
});
