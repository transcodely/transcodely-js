import { describe, expect, it } from "vitest";

import { toWireJson } from "../../src/codec/json.js";
import { Job, JobStatus } from "../../src/gen/transcodely/v1/job_pb.js";
import { Video } from "../../src/gen/transcodely/v1/video_pb.js";

describe("toWireJson", () => {
  it("renders snake_case field names, not protobuf-JSON camelCase", () => {
    const video = new Video({ id: "vid_a1b2c3d4e5f6g7", appId: "app_k1l2m3n4o5" });
    const json = toWireJson(video) as Record<string, unknown>;
    expect(json.app_id).toBe("app_k1l2m3n4o5");
    expect(json).not.toHaveProperty("appId");
  });

  it("simplifies enums to the lowercase wire spelling", () => {
    const job = new Job({ id: "job_a1b2c3d4e5f6", status: JobStatus.COMPLETED });
    const json = toWireJson(job) as Record<string, unknown>;
    expect(json.status).toBe("completed");
    expect(json.status).not.toBe("JOB_STATUS_COMPLETED");
  });

  it("emits unpopulated fields by default, matching the API's own responses", () => {
    const json = toWireJson(new Job({ id: "job_a1b2c3d4e5f6" })) as Record<string, unknown>;
    expect(json).toHaveProperty("progress", 0);
    expect(json).toHaveProperty("outputs");
  });

  it("can be asked to drop unpopulated fields", () => {
    const json = toWireJson(new Job({ id: "job_a1b2c3d4e5f6" }), {
      emitDefaultValues: false,
    }) as Record<string, unknown>;
    expect(json).not.toHaveProperty("progress");
  });
});
