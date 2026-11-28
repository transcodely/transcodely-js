/**
 * The JSON the browser uploader and `createUploadHandler` exchange: one POST
 * endpoint, snake_case bodies, an `action` discriminator. Errors are any
 * non-2xx status with `{ error: { code, message } }`.
 */

export interface WireFile {
  name: string;
  size: number;
  type: string;
  last_modified?: number;
}

export interface WirePartUrl {
  part_number: number;
  url: string;
}

export type UploadRequest =
  | { action: "create"; file: WireFile; metadata?: { title?: string; description?: string } }
  | { action: "sign_parts"; ticket: string; part_numbers: number[] }
  | { action: "complete"; ticket: string; parts: { part_number: number; etag: string }[] }
  | { action: "abort"; ticket: string };

export interface CreateUploadResponse {
  /** Signed, short-lived proof that this browser opened this upload. */
  ticket: string;
  video_id: string;
  upload_id: string;
  part_size: number;
  total_parts: number;
  /** RFC 3339. The ticket, and with it the chance to resume, ends here. */
  expires_at: string;
  /** Presigned PUT URLs for the first parts. */
  parts: WirePartUrl[];
  urls_expire_at: string;
}

export interface SignPartsResponse {
  parts: WirePartUrl[];
  urls_expire_at: string;
}

export interface CompleteUploadResponse {
  video_id: string;
  status: string;
}

export interface UploadErrorBody {
  error: { code: string; message: string };
}
