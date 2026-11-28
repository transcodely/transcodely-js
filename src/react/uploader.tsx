import { useState, type ChangeEvent, type DragEvent } from "react";

import { MAX_FILE_SIZE, type TranscodelyUploadError, type UploadState } from "../browser-upload/index.js";
import { useTranscodelyUpload, type UseTranscodelyUploadOptions } from "./use-upload.js";

/** Every piece of text the component shows. Pass any subset as `messages` to replace it. */
export interface Messages {
  choose: string;
  pause: string;
  resume: string;
  cancel: string;
  retry: string;
  /** Text for the screen-reader status line; uploading also gets the percent, in 10% steps. */
  status: Record<UploadState, string>;
  /** `limit` is already formatted, e.g. "5 GB". */
  tooLarge(limit: string): string;
  wrongType: string;
  empty: string;
  refused: string;
  network: string;
  failed: string;
}

export const defaultMessages: Messages = {
  choose: "Choose a video or drop it here",
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel",
  retry: "Retry",
  status: {
    idle: "",
    preparing: "Preparing the upload.",
    uploading: "Uploading",
    paused: "Upload paused.",
    offline: "You are offline. The upload continues when the connection is back.",
    completing: "Finishing the upload.",
    success: "Upload complete.",
    error: "Upload failed.",
    canceled: "Upload canceled.",
  },
  tooLarge: (limit) => `This file is too large. The limit is ${limit}.`,
  wrongType: "This type of file is not accepted. Choose a video file.",
  empty: "This file is empty. Choose another file.",
  refused: "The upload was refused.",
  network: "The connection failed. Check your network, then choose Retry.",
  failed: "The upload failed. Choose Retry to try again.",
};

export interface TranscodelyUploaderProps extends UseTranscodelyUploadOptions {
  className?: string;
  disabled?: boolean;
  messages?: Partial<Messages>;
}

const UNITS = ["bytes", "KB", "MB", "GB", "TB"];

/** 12.3 MB, 100 MB, 5 GB: binary multiples, at most one decimal. */
export function formatBytes(n: number): string {
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i ? Math.round(n * 10) / 10 : n} ${UNITS[i]}`;
}

function errorText(error: TranscodelyUploadError, m: Messages, maxFileSize: number | undefined): string {
  switch (error.code) {
    case "file_too_large":
      return m.tooLarge(formatBytes(Math.min(maxFileSize ?? MAX_FILE_SIZE, MAX_FILE_SIZE)));
    case "file_type_not_accepted":
      return m.wrongType;
    case "file_empty":
      return m.empty;
    case "forbidden":
    case "unauthenticated":
      return error.message || m.refused;
    case "network":
      return m.network;
    default:
      return error.message || m.failed;
  }
}

/** Errors about the file itself: retrying the same file cannot help. */
const FINAL = ["file_empty", "file_too_large", "file_type_not_accepted"];

const HIDDEN = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
} as const;

/**
 * A drop zone and file picker that uploads through your own endpoint, with
 * progress, pause, resume, cancel and retry. Unstyled: style it through its
 * `data-` attributes, or import `@transcodely/sdk/react/styles.css`.
 */
export function TranscodelyUploader({ className, disabled, messages, ...options }: TranscodelyUploaderProps) {
  const u = useTranscodelyUpload(options);
  const [dragging, setDragging] = useState(false);
  const m = { ...defaultMessages, ...messages, status: { ...defaultMessages.status, ...messages?.status } };
  const { state, progress } = u;
  const busy = state === "preparing" || state === "uploading" || state === "paused" || state === "offline" || state === "completing";
  const off = disabled || busy;

  const pick = (file: File | undefined) => {
    if (file && !off) void u.start(file);
  };
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    pick(e.target.files?.[0]);
    e.target.value = "";
  };
  const onDrag = (e: DragEvent, over: boolean) => {
    e.preventDefault();
    setDragging(over && !off);
  };
  const onDrop = (e: DragEvent) => {
    onDrag(e, false);
    pick(e.dataTransfer.files[0]);
  };

  const status =
    state === "uploading" ? `${m.status.uploading} ${Math.floor(progress.percent / 10) * 10}%` : m.status[state];
  const button = (part: "pause" | "resume" | "cancel" | "retry", onClick: () => unknown) => (
    <button type="button" data-part={part} onClick={() => void onClick()}>
      {m[part]}
    </button>
  );

  return (
    <div data-transcodely-uploader="" data-state={state} className={className}>
      <label
        data-part="dropzone"
        data-dragging={dragging || undefined}
        data-disabled={off || undefined}
        onDragOver={(e) => onDrag(e, true)}
        onDragLeave={(e) => onDrag(e, false)}
        onDrop={onDrop}
      >
        <input type="file" data-part="input" accept={options.accept} disabled={off} onChange={onChange} style={HIDDEN} />
        {u.file && state !== "idle" ? u.file.name : m.choose}
      </label>
      {state !== "idle" && (
        <progress
          data-part="progress"
          max={100}
          value={progress.percent}
          aria-label={u.file?.name}
          aria-valuetext={`${formatBytes(progress.loaded)} of ${formatBytes(progress.total)} (${progress.percent}%)`}
        />
      )}
      <p data-part="status" role="status" aria-live="polite">
        {status}
      </p>
      {u.error && (
        <p data-part="error" role="alert">
          {errorText(u.error, m, options.maxFileSize)}
        </p>
      )}
      {(state === "uploading" || state === "offline") && button("pause", u.pause)}
      {state === "paused" && button("resume", u.resume)}
      {busy && state !== "completing" && button("cancel", u.cancel)}
      {state === "error" && !FINAL.includes(u.error?.code ?? "") && button("retry", u.retry)}
    </div>
  );
}
