import type { PartialMessage } from "@bufbuild/protobuf";

import { AppService } from "../gen/transcodely/v1/app_connect.js";
import {
  type App,
  ArchiveAppRequest,
  CreateAppRequest,
  EnableHostingRequest,
  GetAppRequest,
  type GetSpendResponse,
  GetSpendRequest,
  ListAppsRequest,
  UpdateAppRequest,
  UpdateHostingConfigRequest,
  UpdateSpendLimitRequest,
} from "../gen/transcodely/v1/app_pb.js";
import { PaginationRequest } from "../gen/transcodely/v1/common_pb.js";

import { Page } from "../pagination.js";
import type { CallOptions, Transport } from "../transport/transport.js";

export class Apps {
  constructor(private readonly transport: Transport) {}

  async create(req: PartialMessage<CreateAppRequest>, opts?: CallOptions): Promise<App> {
    const res = await this.transport.unary(
      AppService,
      AppService.methods.create,
      new CreateAppRequest(req),
      opts,
    );
    return res.app!;
  }

  async get(id: string, opts?: CallOptions): Promise<App> {
    const res = await this.transport.unary(
      AppService,
      AppService.methods.get,
      new GetAppRequest({ id }),
      opts,
    );
    return res.app!;
  }

  async update(req: PartialMessage<UpdateAppRequest>, opts?: CallOptions): Promise<App> {
    const res = await this.transport.unary(
      AppService,
      AppService.methods.update,
      new UpdateAppRequest(req),
      opts,
    );
    return res.app!;
  }

  list(req: PartialMessage<ListAppsRequest> = {}, opts?: CallOptions): Page<App> {
    return new Page<App>(async (cursor) => {
      const proto = new ListAppsRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        AppService,
        AppService.methods.list,
        proto,
        opts,
      );
      return { items: res.apps, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }

  async archive(id: string, opts?: CallOptions): Promise<App> {
    const res = await this.transport.unary(
      AppService,
      AppService.methods.archive,
      new ArchiveAppRequest({ id }),
      opts,
    );
    return res.app!;
  }

  enableHosting(req: PartialMessage<EnableHostingRequest>, opts?: CallOptions) {
    return this.transport.unary(
      AppService,
      AppService.methods.enableHosting,
      new EnableHostingRequest(req),
      opts,
    );
  }

  updateHostingConfig(req: PartialMessage<UpdateHostingConfigRequest>, opts?: CallOptions) {
    return this.transport.unary(
      AppService,
      AppService.methods.updateHostingConfig,
      new UpdateHostingConfigRequest(req),
      opts,
    );
  }

  /**
   * Set or clear an app's monthly transcoding spend cap. Provide
   * `monthlySpendLimitEur` (must be > 0) to set the cap; omit it to clear the
   * cap and return the app to unlimited. {@link setSpendLimit} and
   * {@link clearSpendLimit} are the ergonomic shorthands.
   */
  async updateSpendLimit(
    req: PartialMessage<UpdateSpendLimitRequest>,
    opts?: CallOptions,
  ): Promise<App> {
    const res = await this.transport.unary(
      AppService,
      AppService.methods.updateSpendLimit,
      new UpdateSpendLimitRequest(req),
      opts,
    );
    return res.app!;
  }

  /**
   * Set the app's monthly transcoding spend cap in EUR (must be > 0). Once
   * recorded spend for the current billing period reaches the cap, new jobs are
   * rejected with the `limit_exceeded` error code; in-flight jobs are never
   * stopped. Use {@link clearSpendLimit} to return the app to unlimited.
   */
  setSpendLimit(id: string, monthlySpendLimitEur: number, opts?: CallOptions): Promise<App> {
    return this.updateSpendLimit({ appId: id, monthlySpendLimitEur }, opts);
  }

  /**
   * Clear the app's monthly spend cap, returning it to unlimited (the default).
   * Omitting the optional limit field tells the server to clear any existing cap.
   */
  clearSpendLimit(id: string, opts?: CallOptions): Promise<App> {
    return this.updateSpendLimit({ appId: id }, opts);
  }

  /**
   * Get the app's current-period transcoding spend against its limit: the
   * billing-period bounds, EUR spent so far, the cap (if set), and whether the
   * 80% warning and 100% breach events have fired this period.
   */
  getSpend(id: string, opts?: CallOptions): Promise<GetSpendResponse> {
    return this.transport.unary(
      AppService,
      AppService.methods.getSpend,
      new GetSpendRequest({ appId: id }),
      opts,
    );
  }
}
