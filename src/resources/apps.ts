import type { PartialMessage } from "@bufbuild/protobuf";

import { AppService } from "../gen/transcodely/v1/app_connect.js";
import {
  type App,
  ArchiveAppRequest,
  CreateAppRequest,
  EnableHostingRequest,
  GetAppRequest,
  ListAppsRequest,
  UpdateAppRequest,
  UpdateHostingConfigRequest,
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
}
