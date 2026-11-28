/**
 * TYPE-LEVEL STUB of `@transcodely/sdk/upload/server` (DESIGN.md, "Server
 * handler"). The real handler is written in another worktree and replaces
 * this file; `createUploadHandler` throws.
 */

import type { PartialMessage } from "@bufbuild/protobuf";
import type {
  AbortMultipartUploadRequest,
  CompleteMultipartUploadRequest,
  CreateMultipartUploadRequest,
  GetUploadPartUrlsRequest,
} from "@transcodely/sdk";

import { MAX_FILE_SIZE } from "./index.js";

export type UploadAction = "create" | "sign_parts" | "complete" | "abort";

export type UploadDefaults = Omit<
  PartialMessage<CreateMultipartUploadRequest>,
  "filename" | "contentType" | "sizeBytes" | "totalParts" | "partSizeBytes"
>;

export interface UploadHandlerClient {
  videos: {
    createMultipartUpload(req: PartialMessage<CreateMultipartUploadRequest>): Promise<unknown>;
    getUploadPartUrls(req: PartialMessage<GetUploadPartUrlsRequest>): Promise<unknown>;
    completeMultipartUpload(req: PartialMessage<CompleteMultipartUploadRequest>): Promise<unknown>;
    abortMultipartUpload(req: PartialMessage<AbortMultipartUploadRequest>): Promise<unknown>;
  };
}

export interface AuthorizeContext {
  action: UploadAction;
  file?: { name: string; size: number; type: string; lastModified?: number };
}

export type AuthorizeResult =
  | { allow: false; message?: string; status?: 401 | 403 }
  | { allow: true; subject?: string; defaults?: UploadDefaults };

export interface UploadHandlerOptions {
  client: UploadHandlerClient;
  authorize: (request: Request, ctx: AuthorizeContext) => AuthorizeResult | Promise<AuthorizeResult>;
  secret?: string;
  maxFileSize?: number;
  accept?: string;
  ticketTtlSeconds?: number;
}

export function createUploadHandler(_options: UploadHandlerOptions): (request: Request) => Promise<Response> {
  void MAX_FILE_SIZE;
  throw new Error("not implemented");
}
