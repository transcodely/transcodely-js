import type { PartialMessage } from "@bufbuild/protobuf";

import { PresetService } from "../gen/transcodely/v1/preset_connect.js";
import {
  ArchivePresetRequest,
  CreatePresetRequest,
  DuplicatePresetRequest,
  GetPresetBySlugRequest,
  GetPresetRequest,
  ListPresetsRequest,
  type Preset,
  UpdatePresetRequest,
} from "../gen/transcodely/v1/preset_pb.js";
import { PaginationRequest } from "../gen/transcodely/v1/common_pb.js";

import { Page } from "../pagination.js";
import type { CallOptions, Transport } from "../transport/transport.js";

export class Presets {
  constructor(private readonly transport: Transport) {}

  async create(req: PartialMessage<CreatePresetRequest>, opts?: CallOptions): Promise<Preset> {
    const res = await this.transport.unary(
      PresetService,
      PresetService.methods.create,
      new CreatePresetRequest(req),
      opts,
    );
    return res.preset!;
  }

  async get(id: string, opts?: CallOptions): Promise<Preset> {
    const res = await this.transport.unary(
      PresetService,
      PresetService.methods.get,
      new GetPresetRequest({ id }),
      opts,
    );
    return res.preset!;
  }

  async getBySlug(slug: string, opts?: CallOptions): Promise<Preset> {
    const res = await this.transport.unary(
      PresetService,
      PresetService.methods.getBySlug,
      new GetPresetBySlugRequest({ slug }),
      opts,
    );
    return res.preset!;
  }

  list(req: PartialMessage<ListPresetsRequest> = {}, opts?: CallOptions): Page<Preset> {
    return new Page<Preset>(async (cursor) => {
      const proto = new ListPresetsRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        PresetService,
        PresetService.methods.list,
        proto,
        opts,
      );
      return { items: res.presets, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }

  async update(req: PartialMessage<UpdatePresetRequest>, opts?: CallOptions): Promise<Preset> {
    const res = await this.transport.unary(
      PresetService,
      PresetService.methods.update,
      new UpdatePresetRequest(req),
      opts,
    );
    return res.preset!;
  }

  async duplicate(req: PartialMessage<DuplicatePresetRequest>, opts?: CallOptions): Promise<Preset> {
    const res = await this.transport.unary(
      PresetService,
      PresetService.methods.duplicate,
      new DuplicatePresetRequest(req),
      opts,
    );
    return res.preset!;
  }

  async archive(id: string, opts?: CallOptions): Promise<Preset> {
    const res = await this.transport.unary(
      PresetService,
      PresetService.methods.archive,
      new ArchivePresetRequest({ id }),
      opts,
    );
    return res.preset!;
  }
}
