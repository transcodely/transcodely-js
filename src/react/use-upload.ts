import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  createUpload,
  type CreateUploadOptions,
  type TranscodelyUploadError,
  type Upload,
  type UploadProgress,
  type UploadResult,
  type UploadState,
} from "../browser-upload/index.js";

type Text = string | ((file: File) => string);

export interface UseTranscodelyUploadOptions extends Omit<CreateUploadOptions, "metadata"> {
  /** A title or description, or a function of the chosen file that returns one. */
  metadata?: { title?: Text; description?: Text };
  onSuccess?(result: UploadResult): void;
  onError?(error: TranscodelyUploadError): void;
}

export interface TranscodelyUploadControls {
  /** Uploads `file`, resuming an earlier attempt at the same file when one is remembered. */
  start(file: File): Promise<UploadResult | undefined>;
  pause(): void;
  resume(): void;
  cancel(): Promise<void>;
  /** Starts the last file again after an error; parts already uploaded are kept. */
  retry(): Promise<UploadResult | undefined>;
  /** Forgets the current file. An upload still running is paused, so it stays resumable. */
  reset(): void;
  state: UploadState;
  progress: UploadProgress;
  error: TranscodelyUploadError | undefined;
  videoId: string | undefined;
  file: File | undefined;
}

const ACTIVE: UploadState[] = ["preparing", "uploading", "offline"];
const noop = () => () => {};
const idle = () => "";

/**
 * The headless uploader: state, progress and controls for one file at a time.
 * Renders on the server as `idle`; an upload still running when the component
 * unmounts is paused, never canceled, so picking the same file again resumes it.
 */
export function useTranscodelyUpload(options: UseTranscodelyUploadOptions): TranscodelyUploadControls {
  const latest = useRef(options);
  latest.current = options;
  const [current, setCurrent] = useState<{ upload: Upload; file: File }>();
  const upload = current?.upload;

  useSyncExternalStore(
    upload ? upload.subscribe : noop,
    // A string snapshot is stable between changes, as useSyncExternalStore requires.
    upload ? () => `${upload.state} ${upload.progress.loaded} ${upload.progress.total}` : idle,
    idle,
  );

  const live = useRef(upload);
  live.current = upload;
  useEffect(
    () => () => {
      const u = live.current;
      if (u && ACTIVE.includes(u.state)) u.pause();
    },
    [],
  );

  const start = useCallback((file: File) => {
    const previous = live.current;
    if (previous && ACTIVE.includes(previous.state)) previous.pause();
    const { metadata, onSuccess: _s, onError: _e, ...rest } = latest.current;
    const text = (t: Text | undefined) => (typeof t === "function" ? t(file) : t);
    const next = createUpload(file, {
      ...rest,
      onProgress: (p) => latest.current.onProgress?.(p),
      onStateChange: (s) => latest.current.onStateChange?.(s),
      ...(metadata && {
        metadata: { title: text(metadata.title), description: text(metadata.description) },
      }),
    });
    live.current = next;
    setCurrent({ upload: next, file });
    return next.start().then(
      (result) => {
        latest.current.onSuccess?.(result);
        return result;
      },
      (error: TranscodelyUploadError) => {
        if (error.code !== "aborted") latest.current.onError?.(error);
        return undefined;
      },
    );
  }, []);

  const file = current?.file;
  const total = file?.size ?? 0;
  return {
    start,
    pause: () => upload?.pause(),
    resume: () => upload?.resume(),
    cancel: async () => upload?.cancel(),
    retry: async () => (file ? start(file) : undefined),
    reset: () => {
      if (upload && ACTIVE.includes(upload.state)) upload.pause();
      live.current = undefined;
      setCurrent(undefined);
    },
    state: upload?.state ?? "idle",
    progress: upload?.progress ?? { loaded: 0, total, percent: 0 },
    error: upload?.error,
    videoId: upload?.videoId,
    file,
  };
}
