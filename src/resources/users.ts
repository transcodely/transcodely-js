import type { PartialMessage } from "@bufbuild/protobuf";

import { UserService } from "../gen/transcodely/v1/user_connect.js";
import {
  GetMeRequest,
  GetUserRequest,
  ListUsersRequest,
  UpdateMeRequest,
  type User,
  type UserWithOrganizations,
} from "../gen/transcodely/v1/user_pb.js";
import { PaginationRequest } from "../gen/transcodely/v1/common_pb.js";

import { Page } from "../pagination.js";
import type { CallOptions, Transport } from "../transport/transport.js";

export class Users {
  constructor(private readonly transport: Transport) {}

  /** Returns the authenticated user enriched with their org memberships. */
  async getMe(opts?: CallOptions): Promise<UserWithOrganizations> {
    const res = await this.transport.unary(
      UserService,
      UserService.methods.getMe,
      new GetMeRequest(),
      opts,
    );
    return res.user!;
  }

  async updateMe(req: PartialMessage<UpdateMeRequest>, opts?: CallOptions): Promise<User> {
    const res = await this.transport.unary(
      UserService,
      UserService.methods.updateMe,
      new UpdateMeRequest(req),
      opts,
    );
    return res.user!;
  }

  async get(id: string, opts?: CallOptions): Promise<User> {
    const res = await this.transport.unary(
      UserService,
      UserService.methods.get,
      new GetUserRequest({ id }),
      opts,
    );
    return res.user!;
  }

  list(req: PartialMessage<ListUsersRequest> = {}, opts?: CallOptions): Page<User> {
    return new Page<User>(async (cursor) => {
      const proto = new ListUsersRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        UserService,
        UserService.methods.list,
        proto,
        opts,
      );
      return { items: res.users, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }
}
