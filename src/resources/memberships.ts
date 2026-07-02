import type { PartialMessage } from "@bufbuild/protobuf";

import { MembershipService } from "../gen/transcodely/v1/membership_connect.js";
import {
  GetMembershipRequest,
  ListMembershipsRequest,
  type MembershipWithUser,
  RemoveMembershipRequest,
  UpdateMembershipRoleRequest,
} from "../gen/transcodely/v1/membership_pb.js";
import { PaginationRequest } from "../gen/transcodely/v1/common_pb.js";

import { Page } from "../pagination.js";
import type { CallOptions, Transport } from "../transport/transport.js";

export class Memberships {
  constructor(private readonly transport: Transport) {}

  list(
    req: PartialMessage<ListMembershipsRequest> = {},
    opts?: CallOptions,
  ): Page<MembershipWithUser> {
    return new Page<MembershipWithUser>(async (cursor) => {
      const proto = new ListMembershipsRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        MembershipService,
        MembershipService.methods.list,
        proto,
        opts,
      );
      return { items: res.memberships, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }

  async get(id: string, opts?: CallOptions): Promise<MembershipWithUser> {
    const res = await this.transport.unary(
      MembershipService,
      MembershipService.methods.get,
      new GetMembershipRequest({ id }),
      opts,
    );
    return res.membership!;
  }

  async updateRole(
    req: PartialMessage<UpdateMembershipRoleRequest>,
    opts?: CallOptions,
  ): Promise<MembershipWithUser> {
    const res = await this.transport.unary(
      MembershipService,
      MembershipService.methods.updateRole,
      new UpdateMembershipRoleRequest(req),
      opts,
    );
    return res.membership!;
  }

  async remove(id: string, opts?: CallOptions): Promise<void> {
    await this.transport.unary(
      MembershipService,
      MembershipService.methods.remove,
      new RemoveMembershipRequest({ id }),
      opts,
    );
  }
}
