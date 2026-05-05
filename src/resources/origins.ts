import type { PartialMessage } from "@bufbuild/protobuf";

import { OriginService } from "../gen/transcodely/v1/origin_connect.js";
import {
  ArchiveOriginRequest,
  CreateOriginRequest,
  GetOriginRequest,
  ListOriginsRequest,
  type Origin,
  UpdateOriginRequest,
  ValidateOriginRequest,
} from "../gen/transcodely/v1/origin_pb.js";
import { PaginationRequest } from "../gen/transcodely/v1/common_pb.js";

import { Page } from "../pagination.js";
import type { CallOptions, Transport } from "../transport/transport.js";

export class Origins {
  constructor(private readonly transport: Transport) {}

  async create(req: PartialMessage<CreateOriginRequest>, opts?: CallOptions): Promise<Origin> {
    const res = await this.transport.unary(
      OriginService,
      OriginService.methods.create,
      new CreateOriginRequest(req),
      opts,
    );
    return res.origin!;
  }

  async get(id: string, opts?: CallOptions): Promise<Origin> {
    const res = await this.transport.unary(
      OriginService,
      OriginService.methods.get,
      new GetOriginRequest({ id }),
      opts,
    );
    return res.origin!;
  }

  list(req: PartialMessage<ListOriginsRequest> = {}, opts?: CallOptions): Page<Origin> {
    return new Page<Origin>(async (cursor) => {
      const proto = new ListOriginsRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        OriginService,
        OriginService.methods.list,
        proto,
        opts,
      );
      return { items: res.origins, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }

  async update(req: PartialMessage<UpdateOriginRequest>, opts?: CallOptions): Promise<Origin> {
    const res = await this.transport.unary(
      OriginService,
      OriginService.methods.update,
      new UpdateOriginRequest(req),
      opts,
    );
    return res.origin!;
  }

  validate(req: PartialMessage<ValidateOriginRequest>, opts?: CallOptions) {
    return this.transport.unary(
      OriginService,
      OriginService.methods.validate,
      new ValidateOriginRequest(req),
      opts,
    );
  }

  async archive(id: string, opts?: CallOptions): Promise<Origin> {
    const res = await this.transport.unary(
      OriginService,
      OriginService.methods.archive,
      new ArchiveOriginRequest({ id }),
      opts,
    );
    return res.origin!;
  }
}
