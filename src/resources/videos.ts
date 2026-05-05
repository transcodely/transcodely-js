import type { PartialMessage } from "@bufbuild/protobuf";

import { VideoService } from "../gen/transcodely/v1/video_connect.js";
import {
  AbortMultipartUploadRequest,
  CompleteMultipartUploadRequest,
  CompleteUploadRequest,
  CreateMultipartUploadRequest,
  CreateUploadRequest,
  DeleteVideoRequest,
  GetUploadPartUrlsRequest,
  GetUsageRequest,
  GetVideoRequest,
  ListVideosRequest,
  UpdateVideoRequest,
  type Video,
  WatchVideoRequest,
  type WatchVideoResponse,
} from "../gen/transcodely/v1/video_pb.js";

import { Page } from "../pagination.js";
import { watch } from "../streaming.js";
import type { CallOptions, Transport } from "../transport/transport.js";

export class Videos {
  constructor(private readonly transport: Transport) {}

  createUpload(req: PartialMessage<CreateUploadRequest>, opts?: CallOptions) {
    return this.transport.unary(
      VideoService,
      VideoService.methods.createUpload,
      new CreateUploadRequest(req),
      opts,
    );
  }

  completeUpload(req: PartialMessage<CompleteUploadRequest>, opts?: CallOptions) {
    return this.transport.unary(
      VideoService,
      VideoService.methods.completeUpload,
      new CompleteUploadRequest(req),
      opts,
    );
  }

  createMultipartUpload(
    req: PartialMessage<CreateMultipartUploadRequest>,
    opts?: CallOptions,
  ) {
    return this.transport.unary(
      VideoService,
      VideoService.methods.createMultipartUpload,
      new CreateMultipartUploadRequest(req),
      opts,
    );
  }

  getUploadPartUrls(req: PartialMessage<GetUploadPartUrlsRequest>, opts?: CallOptions) {
    return this.transport.unary(
      VideoService,
      VideoService.methods.getUploadPartUrls,
      new GetUploadPartUrlsRequest(req),
      opts,
    );
  }

  completeMultipartUpload(
    req: PartialMessage<CompleteMultipartUploadRequest>,
    opts?: CallOptions,
  ) {
    return this.transport.unary(
      VideoService,
      VideoService.methods.completeMultipartUpload,
      new CompleteMultipartUploadRequest(req),
      opts,
    );
  }

  abortMultipartUpload(
    req: PartialMessage<AbortMultipartUploadRequest>,
    opts?: CallOptions,
  ) {
    return this.transport.unary(
      VideoService,
      VideoService.methods.abortMultipartUpload,
      new AbortMultipartUploadRequest(req),
      opts,
    );
  }

  async get(id: string, opts?: CallOptions): Promise<Video> {
    const res = await this.transport.unary(
      VideoService,
      VideoService.methods.get,
      new GetVideoRequest({ id }),
      opts,
    );
    return res.video!;
  }

  /** List videos. Uses `page_size` / `page_token` instead of standard pagination. */
  list(req: PartialMessage<ListVideosRequest> = {}, opts?: CallOptions): Page<Video> {
    return new Page<Video>(async (cursor) => {
      const proto = new ListVideosRequest(req);
      if (cursor !== undefined) proto.pageToken = cursor;
      const res = await this.transport.unary(
        VideoService,
        VideoService.methods.list,
        proto,
        opts,
      );
      return { items: res.videos, nextCursor: res.nextPageToken || undefined };
    });
  }

  async update(req: PartialMessage<UpdateVideoRequest>, opts?: CallOptions): Promise<Video> {
    const res = await this.transport.unary(
      VideoService,
      VideoService.methods.update,
      new UpdateVideoRequest(req),
      opts,
    );
    return res.video!;
  }

  async delete(id: string, opts?: CallOptions): Promise<void> {
    await this.transport.unary(
      VideoService,
      VideoService.methods.delete,
      new DeleteVideoRequest({ id }),
      opts,
    );
  }

  watch(
    id: string,
    opts: { signal?: AbortSignal; includeHeartbeats?: boolean } = {},
  ): AsyncIterable<WatchVideoResponse> {
    // VideoService.Watch event field is a string per proto; treat "heartbeat" as filterable.
    return watch<WatchVideoResponse>(
      (signal) =>
        this.transport.stream(
          VideoService,
          VideoService.methods.watch,
          new WatchVideoRequest({ id }),
          { signal },
        ),
      {
        includeHeartbeats: opts.includeHeartbeats,
        signal: opts.signal,
        isHeartbeat: (event) =>
          (event as unknown as { event?: string }).event === "heartbeat",
      },
    );
  }

  getUsage(req: PartialMessage<GetUsageRequest> = {}, opts?: CallOptions) {
    return this.transport.unary(
      VideoService,
      VideoService.methods.getUsage,
      new GetUsageRequest(req),
      opts,
    );
  }
}
