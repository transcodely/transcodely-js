/**
 * Limits, the error type and the pure helpers both halves of the browser
 * upload protocol agree on. The server handler imports these from
 * `@transcodely/sdk/upload` so a part size can never be computed two ways.
 */

const MiB = 1024 * 1024;

/** Platform upload ceiling enforced by the API (5 GiB). */
export const MAX_FILE_SIZE = 5_368_709_120;

/** Smallest part this uploader uses (16 MiB); only the last part is shorter. */
export const MIN_PART_SIZE = 16 * MiB;

/** S3's ceiling on parts per multipart upload. */
export const MAX_PARTS = 10_000;

/**
 * Part size for a file: 16 MiB, or as many whole MiB as it takes to keep the
 * part count inside 10,000. Decided by the server and sent to the browser, so
 * a resumed upload always slices the way it was opened.
 */
export function partSizeFor(size: number): number {
  return Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS / MiB) * MiB);
}

/** Parts a file of `size` bytes splits into at `partSize`. */
export const partsFor = (size: number, partSize: number): number =>
  Math.max(1, Math.ceil(size / partSize));

/**
 * Whether a file matches an `accept` list, with the same rules as
 * `<input accept>`: `.ext`, `type/*` and `type/subtype`, comma separated.
 * An empty or missing list accepts everything. A file with no type is judged
 * by its extension, so `video/*` still takes an untyped `.mkv`.
 */
export function acceptsFile(file: { name: string; type: string }, accept?: string): boolean {
  if (!accept?.trim()) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || videoTypeFor(name)).toLowerCase();
  return accept.split(",").some((raw) => {
    const a = raw.trim().toLowerCase();
    if (!a) return false;
    if (a[0] === ".") return name.endsWith(a);
    if (a === "*/*") return true;
    return a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : type === a;
  });
}

/**
 * Every failure the uploader reports. `code` is one of the uploader's own
 * (`file_empty`, `file_too_large`, `file_type_not_accepted`, `forbidden`,
 * `unauthenticated`, `network`, `storage_error`, `upload_expired`,
 * `ticket_invalid`, `bad_response`, `aborted`) or the wire code your upload
 * endpoint or the Transcodely API returned. `message` is written to be shown
 * to the person uploading.
 */
export class TranscodelyUploadError extends Error {
  readonly code: string;
  /** HTTP status of the response that failed, when there was one. */
  readonly status?: number;
  /** Whether trying again (`retry()`) can succeed without changing anything. */
  readonly retryable: boolean;

  constructor(code: string, message: string, status?: number, retryable = false) {
    super(message);
    this.name = "TranscodelyUploadError";
    this.code = code;
    if (status !== undefined) this.status = status;
    this.retryable = retryable;
  }
}

const UNITS = ["bytes", "KB", "MB", "GB", "TB"];

/** 12.3 MB, 100 MB, 5 GB: binary multiples, at most one decimal. */
export function formatBytes(n: number): string {
  let i = 0;
  while (n >= 1024 && i < 4) {
    n /= 1024;
    i++;
  }
  return `${String(i ? Math.round(n * 10) / 10 : n)} ${UNITS[i]!}`;
}

/**
 * MIME type for a video file name, for files the browser could not type
 * (Chrome on Windows reports `""` for some `.mkv` and `.m2ts` files).
 */
export function videoTypeFor(name: string): string {
  const ext = /\.([^.]+)$/.exec(name)?.[1]!.toLowerCase() ?? "";
  const sub = ({ m4v: "x-m4v", mov: "quicktime", mkv: "x-matroska", avi: "x-msvideo", wmv: "x-ms-wmv", flv: "x-flv",
    mpg: "mpeg", ts: "mp2t", m2ts: "mp2t", mts: "mp2t", "3gp": "3gpp", ogv: "ogg" } as Record<string, string>)[ext];
  return sub ? `video/${sub}` : ["mp4", "webm", "mpeg"].includes(ext) ? `video/${ext}` : "";
}
