/**
 * TYPE-LEVEL STUB of `@transcodely/sdk/upload` (DESIGN.md, "Browser core").
 * The real core is written in another worktree and replaces this file; every
 * function here throws. Exists only so the packaging and React layers can be
 * built and type-checked against the contract.
 */

export const MAX_FILE_SIZE = 5_368_709_120;
export const MIN_PART_SIZE = 16 * 1024 * 1024;
export const MAX_PARTS = 10_000;

function notImplemented(): never {
  throw new Error("not implemented");
}

export function partSizeFor(_size: number): number {
  return notImplemented();
}

export function acceptsFile(_file: { name: string; type: string }, _accept?: string): boolean {
  return notImplemented();
}

export type UploadState =
  | "idle"
  | "preparing"
  | "uploading"
  | "paused"
  | "offline"
  | "completing"
  | "success"
  | "error"
  | "canceled";

export interface UploadProgress {
  loaded: number;
  total: number;
  /** 0..100, floor */
  percent: number;
}

export interface UploadResult {
  videoId: string;
  status: string;
  resumed: boolean;
}

export class TranscodelyUploadError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  constructor(code: string, message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "TranscodelyUploadError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export interface UploadRecord {
  v: 1;
  key: string;
  ticket: string;
  videoId: string;
  uploadId: string;
  partSize: number;
  totalParts: number;
  size: number;
  createdAt: number;
  /** ms */
  expiresAt: number;
  /** part -> etag */
  parts: Record<number, string>;
}

export interface UploadStore {
  get(key: string): Promise<UploadRecord | undefined>;
  set(key: string, record: UploadRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export function indexedDBStore(_name?: string): UploadStore {
  return notImplemented();
}

export function memoryStore(): UploadStore {
  return notImplemented();
}

export interface CreateUploadOptions {
  endpoint: string;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  credentials?: RequestCredentials;
  metadata?: { title?: string; description?: string };
  accept?: string;
  maxFileSize?: number;
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
  store?: UploadStore | false;
  fetch?: typeof fetch;
  onProgress?: (p: UploadProgress) => void;
  onStateChange?: (s: UploadState) => void;
}

export interface Upload {
  readonly state: UploadState;
  readonly progress: UploadProgress;
  readonly error: TranscodelyUploadError | undefined;
  readonly videoId: string | undefined;
  start(): Promise<UploadResult>;
  pause(): void;
  resume(): void;
  cancel(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function createUpload(_file: File, _options: CreateUploadOptions): Upload {
  return notImplemented();
}
