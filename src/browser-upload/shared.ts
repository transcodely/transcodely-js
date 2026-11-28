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
 * An empty or missing list accepts everything.
 */
export function acceptsFile(file: { name: string; type: string }, accept?: string): boolean {
  if (!accept?.trim()) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
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

/** "1.5 GB" style sizes for error messages (decimal units, like file managers). */
export function formatBytes(n: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1000 && i < 3) {
    n /= 1000;
    i++;
  }
  return `${i ? n.toFixed(1).replace(/\.0$/, "") : String(n)} ${units[i]!}`;
}
