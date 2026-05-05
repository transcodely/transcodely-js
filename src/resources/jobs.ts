import type { PartialMessage } from "@bufbuild/protobuf";

import { JobService } from "../gen/transcodely/v1/job_connect.js";
import {
  CancelJobRequest,
  ConfirmJobRequest,
  CreateJobRequest,
  GetJobRequest,
  type Job,
  ListJobsRequest,
  WatchEventType,
  type WatchJobResponse,
  WatchJobRequest,
} from "../gen/transcodely/v1/job_pb.js";
import { PaginationRequest } from "../gen/transcodely/v1/common_pb.js";

import { Page } from "../pagination.js";
import { watch } from "../streaming.js";
import type { CallOptions, Transport } from "../transport/transport.js";
import { uuidv4 } from "../transport/headers.js";

export class Jobs {
  constructor(private readonly transport: Transport) {}

  /** Create a new transcoding job. The SDK auto-generates an idempotency key
   * if you don't pass one. */
  async create(
    req: PartialMessage<CreateJobRequest>,
    opts: CallOptions = {},
  ): Promise<Job> {
    const proto = new CreateJobRequest(req);
    if (!proto.idempotencyKey) {
      proto.idempotencyKey = opts.idempotencyKey ?? uuidv4();
    }
    const res = await this.transport.unary(
      JobService,
      JobService.methods.create,
      proto,
      opts,
    );
    return res.job!;
  }

  /** Fetch a job by ID. */
  async get(id: string, opts?: CallOptions): Promise<Job> {
    const res = await this.transport.unary(
      JobService,
      JobService.methods.get,
      new GetJobRequest({ id }),
      opts,
    );
    return res.job!;
  }

  /** List jobs. Returns a `Page` — `await` it for one page or `.autoPage()` to iterate all. */
  list(req: PartialMessage<ListJobsRequest> = {}, opts?: CallOptions): Page<Job> {
    return new Page<Job>(async (cursor) => {
      const proto = new ListJobsRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        JobService,
        JobService.methods.list,
        proto,
        opts,
      );
      return { items: res.jobs, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }

  /** Cancel a pending or running job. */
  async cancel(id: string, opts?: CallOptions): Promise<Job> {
    const res = await this.transport.unary(
      JobService,
      JobService.methods.cancel,
      new CancelJobRequest({ id }),
      opts,
    );
    return res.job!;
  }

  /** Confirm a delayed-start job that's awaiting confirmation. */
  async confirm(id: string, opts?: CallOptions): Promise<Job> {
    const res = await this.transport.unary(
      JobService,
      JobService.methods.confirm,
      new ConfirmJobRequest({ id }),
      opts,
    );
    return res.job!;
  }

  /** Stream live updates for a job. Auto-reconnects on transient failures and
   * filters HEARTBEAT events; stream ends when the job hits a terminal state. */
  watch(
    id: string,
    opts: { signal?: AbortSignal; includeHeartbeats?: boolean } = {},
  ): AsyncIterable<WatchJobResponse> {
    return watch<WatchJobResponse>(
      (signal) =>
        this.transport.stream(
          JobService,
          JobService.methods.watch,
          new WatchJobRequest({ id }),
          { signal },
        ),
      {
        includeHeartbeats: opts.includeHeartbeats,
        signal: opts.signal,
        isHeartbeat: (event) => event.event === WatchEventType.HEARTBEAT,
      },
    );
  }
}
