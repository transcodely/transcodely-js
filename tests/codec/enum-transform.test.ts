import { proto3 } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
  camelToScreamingSnake,
  enumPrefix,
  expandEnumValue,
  simplifyEnumValue,
  transformEnumsInJson,
} from "../../src/codec/enum-transform.js";
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
} from "../../src/gen/transcodely/v1/job_pb.js";

// Generated TS enums are bare numeric enums. Their @bufbuild/protobuf reflection
// metadata is registered at import time and retrieved via proto3.getEnumType.
const JobStatusT = proto3.getEnumType(JobStatus);
const JobPriorityT = proto3.getEnumType(JobPriority);
const VideoCodecT = proto3.getEnumType(VideoCodec);
const ResolutionT = proto3.getEnumType(Resolution);
const OutputFormatT = proto3.getEnumType(OutputFormat);

describe("camelToScreamingSnake", () => {
  it("splits CamelCase on every boundary", () => {
    expect(camelToScreamingSnake("JobStatus")).toBe("JOB_STATUS");
    expect(camelToScreamingSnake("OutputFormat")).toBe("OUTPUT_FORMAT");
  });

  it("keeps adjacent uppercase together when followed by lowercase", () => {
    expect(camelToScreamingSnake("APIKeyEnvironment")).toBe("API_KEY_ENVIRONMENT");
    expect(camelToScreamingSnake("HTTPCredentials")).toBe("HTTP_CREDENTIALS");
  });
});

describe("enumPrefix", () => {
  it("derives the proto enum prefix from the simple TS enum name", () => {
    expect(enumPrefix(JobStatusT)).toBe("JOB_STATUS_");
    expect(enumPrefix(VideoCodecT)).toBe("VIDEO_CODEC_");
    expect(enumPrefix(OutputFormatT)).toBe("OUTPUT_FORMAT_");
  });
});

describe("simplifyEnumValue", () => {
  it("strips the prefix and lowercases the suffix", () => {
    expect(simplifyEnumValue("JOB_STATUS_PENDING", JobStatusT)).toBe("pending");
    expect(simplifyEnumValue("VIDEO_CODEC_H264", VideoCodecT)).toBe("h264");
    expect(simplifyEnumValue("RESOLUTION_1080P", ResolutionT)).toBe("1080p");
  });

  it("falls back to lowercase when prefix is absent", () => {
    expect(simplifyEnumValue("UNKNOWN", JobStatusT)).toBe("unknown");
  });
});

describe("expandEnumValue", () => {
  it("turns the simplified form back into the canonical proto name", () => {
    expect(expandEnumValue("pending", JobStatusT)).toBe("JOB_STATUS_PENDING");
    expect(expandEnumValue("h264", VideoCodecT)).toBe("VIDEO_CODEC_H264");
    expect(expandEnumValue("1080p", ResolutionT)).toBe("RESOLUTION_1080P");
  });

  it("returns input unchanged when already canonical", () => {
    expect(expandEnumValue("JOB_STATUS_PENDING", JobStatusT)).toBe("JOB_STATUS_PENDING");
  });

  it("returns input unchanged when no enum value matches", () => {
    expect(expandEnumValue("totally_unknown", JobStatusT)).toBe("totally_unknown");
  });
});

describe("transformEnumsInJson — simplify mode", () => {
  it("rewrites scalar, repeated, and nested-message enum strings", () => {
    const obj: Record<string, unknown> = {
      input_url: "https://example.com/in.mp4",
      priority: "JOB_PRIORITY_PREMIUM",
      outputs: [
        {
          type: "OUTPUT_FORMAT_HLS",
          video: [
            { codec: "VIDEO_CODEC_H264", resolution: "RESOLUTION_1080P" },
            { codec: "VIDEO_CODEC_AV1", resolution: "RESOLUTION_2160P" },
          ],
        },
      ],
    };

    transformEnumsInJson(obj, CreateJobRequest, "simplify");

    expect(obj.priority).toBe("premium");
    const outputs = obj.outputs as Array<Record<string, unknown>>;
    expect(outputs[0]!.type).toBe("hls");
    const video = outputs[0]!.video as Array<Record<string, unknown>>;
    expect(video[0]!.codec).toBe("h264");
    expect(video[0]!.resolution).toBe("1080p");
    expect(video[1]!.codec).toBe("av1");
    expect(video[1]!.resolution).toBe("2160p");
  });

  it("expand mode performs the inverse rewrite", () => {
    const obj: Record<string, unknown> = {
      job: { id: "job_a", status: "processing", priority: "premium" },
    };
    transformEnumsInJson(obj, GetJobResponse, "expand");
    const job = obj.job as Record<string, unknown>;
    expect(job.status).toBe("JOB_STATUS_PROCESSING");
    expect(job.priority).toBe("JOB_PRIORITY_PREMIUM");
  });
});

describe("JobPriority canonical mapping", () => {
  it("matches the wire name for each variant", () => {
    expect(simplifyEnumValue("JOB_PRIORITY_STANDARD", JobPriorityT)).toBe("standard");
    expect(simplifyEnumValue("JOB_PRIORITY_ECONOMY", JobPriorityT)).toBe("economy");
    expect(expandEnumValue("standard", JobPriorityT)).toBe("JOB_PRIORITY_STANDARD");
    // Sanity: TS enum entry names are stripped, but the prefix is what's on the wire.
    expect(JobStatus.PROCESSING).toBe(3);
  });
});
