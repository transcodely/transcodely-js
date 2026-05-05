import type { PartialMessage } from "@bufbuild/protobuf";

import { OrganizationService } from "../gen/transcodely/v1/organization_connect.js";
import {
  CheckSlugRequest,
  CreateOrganizationRequest,
  GetOrganizationRequest,
  ListOrganizationsRequest,
  type Organization,
  UpdateOrganizationRequest,
} from "../gen/transcodely/v1/organization_pb.js";
import { PaginationRequest } from "../gen/transcodely/v1/common_pb.js";

import { Page } from "../pagination.js";
import type { CallOptions, Transport } from "../transport/transport.js";

export class Organizations {
  constructor(private readonly transport: Transport) {}

  checkSlug(slug: string, opts?: CallOptions) {
    return this.transport.unary(
      OrganizationService,
      OrganizationService.methods.checkSlug,
      new CheckSlugRequest({ slug }),
      opts,
    );
  }

  async create(
    req: PartialMessage<CreateOrganizationRequest>,
    opts?: CallOptions,
  ): Promise<Organization> {
    const res = await this.transport.unary(
      OrganizationService,
      OrganizationService.methods.create,
      new CreateOrganizationRequest(req),
      opts,
    );
    return res.organization!;
  }

  /** Look up an organization by ID (`org_*`) or slug. */
  async get(idOrSlug: string, opts?: CallOptions): Promise<Organization> {
    const res = await this.transport.unary(
      OrganizationService,
      OrganizationService.methods.get,
      new GetOrganizationRequest({ idOrSlug }),
      opts,
    );
    return res.organization!;
  }

  async update(
    req: PartialMessage<UpdateOrganizationRequest>,
    opts?: CallOptions,
  ): Promise<Organization> {
    const res = await this.transport.unary(
      OrganizationService,
      OrganizationService.methods.update,
      new UpdateOrganizationRequest(req),
      opts,
    );
    return res.organization!;
  }

  list(
    req: PartialMessage<ListOrganizationsRequest> = {},
    opts?: CallOptions,
  ): Page<Organization> {
    return new Page<Organization>(async (cursor) => {
      const proto = new ListOrganizationsRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        OrganizationService,
        OrganizationService.methods.list,
        proto,
        opts,
      );
      return { items: res.organizations, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }
}
