/**
 * `client.uploads` — the byte-pushing half of hosted video creation.
 *
 * The API only ever hands out presigned URLs; the bytes travel straight from
 * the caller to object storage. This namespace wires {@link UploadEngine} to
 * the SDK transport so `putFile` is one call.
 */

import { UploadEngine, type UploadRpcClient } from "../upload.js";
import type { Transport } from "../transport/transport.js";
import { Videos } from "./videos.js";

export class Uploads extends UploadEngine {
  constructor(transport: Transport) {
    const videos = new Videos(transport);
    const rpc: UploadRpcClient = {
      createUpload: (req) => videos.createUpload(req),
      completeUpload: (req) => videos.completeUpload(req),
      createMultipartUpload: (req) => videos.createMultipartUpload(req),
      getUploadPartUrls: (req) => videos.getUploadPartUrls(req),
      completeMultipartUpload: (req) => videos.completeMultipartUpload(req),
      abortMultipartUpload: (req) => videos.abortMultipartUpload(req),
    };
    super(rpc, transport.fetchImpl);
  }
}
