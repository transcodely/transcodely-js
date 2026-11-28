import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTranscodelyUpload, type TranscodelyUploadControls } from "../../src/react/index.js";
import { CORE_READY, ENDPOINT, VIDEO_ID, cleanup, fakeBackend, render, video, waitFor } from "./harness.js";

beforeEach(() => vi.stubGlobal("XMLHttpRequest", undefined));
afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
});

let controls: TranscodelyUploadControls;
function Probe(props: Parameters<typeof useTranscodelyUpload>[0]) {
  controls = useTranscodelyUpload(props);
  return <output data-state={controls.state}>{controls.progress.percent}</output>;
}

describe("useTranscodelyUpload", () => {
  it("starts idle with nothing chosen", async () => {
    await render(<Probe endpoint={ENDPOINT} />);
    expect(controls.state).toBe("idle");
    expect(controls.file).toBeUndefined();
    expect(controls.error).toBeUndefined();
    expect(controls.videoId).toBeUndefined();
    expect(controls.progress).toEqual({ loaded: 0, total: 0, percent: 0 });
  });
});

describe.skipIf(!CORE_READY)(`useTranscodelyUpload uploading${CORE_READY ? "" : " (waits on the real core)"}`, () => {
  it("resolves start() with the result and exposes the video id", async () => {
    const backend = fakeBackend();
    const view = await render(<Probe endpoint={ENDPOINT} fetch={backend.fetch} store={false} />);
    const file = video(1000);
    let result: unknown;
    await act(async () => {
      result = await controls.start(file);
    });
    expect(result).toMatchObject({ videoId: VIDEO_ID, resumed: false });
    expect(controls.state).toBe("success");
    expect(controls.videoId).toBe(VIDEO_ID);
    expect(controls.file).toBe(file);
    expect(view.container.querySelector("output")!.getAttribute("data-state")).toBe("success");
  });

  it("resolves start() with undefined on an error and calls onError once", async () => {
    const backend = fakeBackend();
    const onError = vi.fn();
    await render(<Probe endpoint={ENDPOINT} fetch={backend.fetch} store={false} maxFileSize={10} onError={onError} />);
    let result: unknown = "unset";
    await act(async () => {
      result = await controls.start(video(11));
    });
    expect(result).toBeUndefined();
    expect(controls.state).toBe("error");
    expect(controls.error?.code).toBe("file_too_large");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("uses the latest callbacks without restarting", async () => {
    const backend = fakeBackend({ holdParts: true });
    const first = vi.fn();
    const second = vi.fn();
    const view = await render(<Probe endpoint={ENDPOINT} fetch={backend.fetch} store={false} onSuccess={first} />);
    let done: Promise<unknown> = Promise.resolve();
    await act(async () => {
      done = controls.start(video(1000));
    });
    await view.rerender(<Probe endpoint={ENDPOINT} fetch={backend.fetch} store={false} onSuccess={second} />);
    backend.release();
    await act(async () => {
      await done;
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(backend.calls.filter((c) => c.action === "create")).toHaveLength(1);
  });

  it("reset() forgets the file", async () => {
    const backend = fakeBackend();
    await render(<Probe endpoint={ENDPOINT} fetch={backend.fetch} store={false} />);
    await act(async () => {
      await controls.start(video(1000));
    });
    await act(async () => controls.reset());
    expect(controls.state).toBe("idle");
    expect(controls.file).toBeUndefined();
  });

  it("reports progress from the core", async () => {
    const backend = fakeBackend({ holdParts: true });
    const view = await render(<Probe endpoint={ENDPOINT} fetch={backend.fetch} store={false} />);
    await act(async () => {
      void controls.start(video(1000));
    });
    await waitFor(() => expect(backend.pending()).toBe(1));
    expect(controls.progress.total).toBe(1000);
    backend.release();
    await waitFor(() => expect(view.container.querySelector("output")!.textContent).toBe("100"));
  });
});
