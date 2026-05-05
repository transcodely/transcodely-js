import type { PartialMessage } from "@bufbuild/protobuf";

import { APIKeyService } from "../gen/transcodely/v1/api_key_connect.js";
import {
  type APIKey,
  CreateAPIKeyRequest,
  GetAPIKeyRequest,
  ListAPIKeysRequest,
  RevokeAPIKeyRequest,
} from "../gen/transcodely/v1/api_key_pb.js";
import { PaginationRequest } from "../gen/transcodely/v1/common_pb.js";

import { Page } from "../pagination.js";
import type { CallOptions, Transport } from "../transport/transport.js";

export class ApiKeys {
  constructor(private readonly transport: Transport) {}

  /** Returns the new API key — note `secret` is only available on the response, never refetched. */
  create(req: PartialMessage<CreateAPIKeyRequest>, opts?: CallOptions) {
    return this.transport.unary(
      APIKeyService,
      APIKeyService.methods.create,
      new CreateAPIKeyRequest(req),
      opts,
    );
  }

  async get(id: string, opts?: CallOptions): Promise<APIKey> {
    const res = await this.transport.unary(
      APIKeyService,
      APIKeyService.methods.get,
      new GetAPIKeyRequest({ id }),
      opts,
    );
    return res.apiKey!;
  }

  list(req: PartialMessage<ListAPIKeysRequest> = {}, opts?: CallOptions): Page<APIKey> {
    return new Page<APIKey>(async (cursor) => {
      const proto = new ListAPIKeysRequest(req);
      if (cursor !== undefined) {
        proto.pagination = new PaginationRequest({
          ...(req.pagination ?? {}),
          cursor,
        });
      }
      const res = await this.transport.unary(
        APIKeyService,
        APIKeyService.methods.list,
        proto,
        opts,
      );
      return { items: res.apiKeys, nextCursor: res.pagination?.nextCursor || undefined };
    });
  }

  async revoke(id: string, opts?: CallOptions): Promise<APIKey> {
    const res = await this.transport.unary(
      APIKeyService,
      APIKeyService.methods.revoke,
      new RevokeAPIKeyRequest({ id }),
      opts,
    );
    return res.apiKey!;
  }
}
