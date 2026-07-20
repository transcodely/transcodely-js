import { describe, expect, it, vi } from "vitest";

import { JobService } from "../../src/gen/transcodely/v1/job_connect.js";
import {
  ClipConfig,
  CreateJobResponse,
  Job,
} from "../../src/gen/transcodely/v1/job_pb.js";
import { Jobs } from "../../src/resources/jobs.js";
import { Transport } from "../../src/transport/transport.js";

function makeTransport(): Transport {
  return new Transport({ apiKey: "tk_test", baseUrl: "https://example.invalid" });
}

function fakeJob(overrides: Partial<Job> = {}): Job {
  return new Job({
    id: "job_a1b2c3d4e5f6",
    appId: "app_xyz",
    status: "pending",
    ...overrides,
  });
}

describe("Jobs facade", () => {
  it("create dispatches CreateJob carrying the clip range and returns the job", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValue(
        new CreateJobResponse({
          job: fakeJob({ clip: new ClipConfig({ startSeconds: 2, endSeconds: 7 }) }),
        }),
      );

    const job = await new Jobs(transport).create({
      inputUrl: "https://example.com/video.mp4",
      managed: true,
      clip: { startSeconds: 2, endSeconds: 7 },
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(JobService.methods.create);

    // The constructed request carries the clip as a ClipConfig with the range.
    const req = spy.mock.calls[0][2] as { clip?: ClipConfig; idempotencyKey?: string };
    expect(req.clip).toBeInstanceOf(ClipConfig);
    expect(req.clip?.startSeconds).toBe(2);
    expect(req.clip?.endSeconds).toBe(7);

    // The SDK still auto-generates an idempotency key when none is passed.
    expect(req.idempotencyKey).toBeTruthy();

    // The created job (with its echoed clip) is returned unwrapped.
    expect(job).toBeInstanceOf(Job);
    expect(job.id).toBe("job_a1b2c3d4e5f6");
    expect(job.clip?.endSeconds).toBe(7);
  });

  it("create with an open-ended clip (no endSeconds) defaults endSeconds to 0", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValue(new CreateJobResponse({ job: fakeJob() }));

    await new Jobs(transport).create({
      inputUrl: "https://example.com/video.mp4",
      clip: { startSeconds: 10 },
    });

    const req = spy.mock.calls[0][2] as { clip?: ClipConfig };
    expect(req.clip?.startSeconds).toBe(10);
    // Unset end means "end of input" — protobuf-es defaults the double to 0.
    expect(req.clip?.endSeconds).toBe(0);
  });

  it("create without a clip leaves clip undefined", async () => {
    const transport = makeTransport();
    const spy = vi
      .spyOn(transport, "unary")
      .mockResolvedValue(new CreateJobResponse({ job: fakeJob() }));

    await new Jobs(transport).create({ inputUrl: "https://example.com/video.mp4" });

    const req = spy.mock.calls[0][2] as { clip?: ClipConfig };
    expect(req.clip).toBeUndefined();
  });
});
