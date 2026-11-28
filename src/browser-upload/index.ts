/**
 * `@transcodely/sdk/upload`: resumable browser uploads with no API key in the
 * browser. Pair it with `createUploadHandler` from
 * `@transcodely/sdk/upload/server` on your backend.
 *
 * This is not the tus protocol: it speaks a small JSON protocol with your
 * own handler, which opens a Transcodely multipart upload and signs part URLs.
 *
 * @example
 * ```ts
 * import { createUpload } from "@transcodely/sdk/upload";
 *
 * const upload = createUpload(file, {
 *   endpoint: "/api/transcodely/upload",
 *   onProgress: ({ percent }) => (bar.value = percent),
 * });
 * const { videoId } = await upload.start();
 * ```
 */

export {
  MAX_FILE_SIZE,
  MAX_PARTS,
  MIN_PART_SIZE,
  TranscodelyUploadError,
  acceptsFile,
  formatBytes,
  partSizeFor,
  partsFor,
} from "./shared.js";
export { indexedDBStore, memoryStore, type UploadRecord, type UploadStore } from "./store.js";
export {
  createUpload,
  type CreateUploadOptions,
  type Upload,
  type UploadProgress,
  type UploadResult,
  type UploadState,
} from "./upload.js";
export type * from "./protocol.js";
