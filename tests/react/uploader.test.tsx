import { StrictMode, act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TranscodelyUploader, formatBytes, type TranscodelyUploaderProps } from "../../src/react/index.js";
import {
  CORE_READY,
  ENDPOINT,
  MiB,
  VIDEO_ID,
  buttons,
  choose,
  cleanup,
  click,
  fakeBackend,
  json,
  render,
  video,
  waitFor,
  type FakeBackend,
} from "./harness.js";

// Part PUTs go through the `fetch` option when XMLHttpRequest is missing, so
// the fake backend sees them too.
beforeEach(() => vi.stubGlobal("XMLHttpRequest", undefined));
afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
});

function uploader(backend: FakeBackend, props: Partial<TranscodelyUploaderProps> = {}) {
  return (
    <TranscodelyUploader
      endpoint={ENDPOINT}
      fetch={backend.fetch}
      store={false}
      concurrency={1}
      retries={1}
      retryDelayMs={1}
      {...props}
    />
  );
}

describe("<TranscodelyUploader> before a file is chosen", () => {
  it("renders an idle drop zone with its stable data attributes", async () => {
    const backend = fakeBackend();
    const view = await render(uploader(backend, { accept: "video/*", className: "mine" }));
    const root = view.root();
    expect(root.getAttribute("data-state")).toBe("idle");
    expect(root.className).toBe("mine");
    const zone = view.part("dropzone")!;
    expect(zone.tagName).toBe("LABEL");
    expect(zone.hasAttribute("data-dragging")).toBe(false);
    const input = view.part("input") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.getAttribute("accept")).toBe("video/*");
    // The native input sits inside its label: keyboard and screen-reader
    // users reach it as an ordinary file picker.
    expect(zone.contains(input)).toBe(true);
    expect(zone.textContent).toContain("Choose a video or drop it here");
    expect(view.part("progress")).toBeNull();
    expect(view.part("error")).toBeNull();
    expect(buttons(view)).toEqual([]);
    const status = view.part("status")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(backend.calls).toEqual([]);
  });

  it("marks the drop zone while a file is dragged over it", async () => {
    const view = await render(uploader(fakeBackend()));
    const zone = view.part("dropzone")!;
    await act(async () => {
      zone.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    });
    expect(zone.getAttribute("data-dragging")).toBe("true");
    await act(async () => {
      zone.dispatchEvent(new Event("dragleave", { bubbles: true, cancelable: true }));
    });
    expect(zone.hasAttribute("data-dragging")).toBe(false);
  });

  it("is disabled by the disabled prop", async () => {
    const view = await render(uploader(fakeBackend(), { disabled: true }));
    expect((view.part("input") as HTMLInputElement).disabled).toBe(true);
    expect(view.part("dropzone")!.hasAttribute("data-disabled")).toBe(true);
  });

  it("takes custom messages", async () => {
    const view = await render(uploader(fakeBackend(), { messages: { choose: "Pick a lecture" } }));
    expect(view.part("dropzone")!.textContent).toBe("Pick a lecture");
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 bytes"],
    [512, "512 bytes"],
    [12.3 * MiB, "12.3 MB"],
    [100 * MiB, "100 MB"],
    [5_368_709_120, "5 GB"],
  ])("formats %d as %s", (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });
});

// Everything below drives the real upload core (src/browser-upload) through a
// fake backend. Until the core replaces its type-level stub these are
// skipped, and say so in the test name.
describe.skipIf(!CORE_READY)(`<TranscodelyUploader> uploading${CORE_READY ? "" : " (waits on the real core)"}`, () => {
  it("starts uploading when a file is chosen, then reports success", async () => {
    const backend = fakeBackend();
    const onSuccess = vi.fn();
    const onProgress = vi.fn();
    const onError = vi.fn();
    const view = await render(
      uploader(backend, { onSuccess, onProgress, onError, metadata: { title: (f) => `Lecture: ${f.name}` } }),
    );
    await choose(view, video(1000));
    await waitFor(() => expect(view.root().getAttribute("data-state")).toBe("success"));

    const create = backend.calls.find((c) => c.action === "create")!;
    expect(create.body.file).toMatchObject({ name: "talk.mp4", size: 1000, type: "video/mp4" });
    expect(create.body.metadata).toEqual({ title: "Lecture: talk.mp4" });
    expect(backend.calls.map((c) => c.action)).toEqual(["create", "complete"]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0]![0]).toMatchObject({ videoId: VIDEO_ID, status: "processing", resumed: false });
    expect(onError).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress.mock.calls.at(-1)![0]).toEqual({ loaded: 1000, total: 1000, percent: 100 });
    expect(view.part("status")!.textContent).toBe("Upload complete.");
    expect(view.part("progress")!.getAttribute("aria-valuetext")).toBe("1000 bytes of 1000 bytes (100%)");
    expect(view.part("dropzone")!.textContent).toBe("talk.mp4");
    expect(buttons(view)).toEqual([]);
  });

  it("shows progress in bytes and percent, announced in 10% steps", async () => {
    const backend = fakeBackend({ holdParts: true });
    const view = await render(uploader(backend));
    await choose(view, video(48 * MiB)); // three 16 MiB parts
    await waitFor(() => expect(backend.pending()).toBe(1));
    const progress = view.part("progress") as HTMLProgressElement;
    expect(progress.getAttribute("max")).toBe("100");
    expect(progress.getAttribute("aria-valuetext")).toBe("0 bytes of 48 MB (0%)");
    expect(view.part("status")!.textContent).toBe("Uploading 0%");

    backend.releaseOne();
    await waitFor(() => expect(progress.getAttribute("aria-valuetext")).toBe("16 MB of 48 MB (33%)"));
    expect(progress.getAttribute("value")).toBe("33");
    // The live region moves in 10% steps, never byte by byte.
    expect(view.part("status")!.textContent).toBe("Uploading 30%");

    backend.release();
    await waitFor(() => expect(view.root().getAttribute("data-state")).toBe("success"));
  });

  it("shows Pause and Cancel while uploading, Resume once paused", async () => {
    const backend = fakeBackend({ holdParts: true });
    const view = await render(uploader(backend));
    await choose(view, video(1000));
    await waitFor(() => expect(view.root().getAttribute("data-state")).toBe("uploading"));
    expect(buttons(view)).toEqual(["pause", "cancel"]);
    expect((view.part("input") as HTMLInputElement).disabled).toBe(true);

    await click(view.part("pause"));
    await waitFor(() => expect(view.root().getAttribute("data-state")).toBe("paused"));
    expect(buttons(view)).toEqual(["resume", "cancel"]);
    expect(view.part("status")!.textContent).toBe("Upload paused.");
    expect(backend.abortedPuts).toEqual([1]);

    await click(view.part("resume"));
    await waitFor(() => expect(backend.pending()).toBe(1));
    expect(view.root().getAttribute("data-state")).toBe("uploading");
    backend.release();
    await waitFor(() => expect(view.root().getAttribute("data-state")).toBe("success"));
  });

  it("cancels: aborts the multipart upload and reports no error", async () => {
    const backend = fakeBackend({ holdParts: true });
    const onError = vi.fn();
    const view = await render(uploader(backend, { onError }));
    await choose(view, video(1000));
    await waitFor(() => expect(backend.pending()).toBe(1));
    await click(view.part("cancel"));
    await waitFor(() => expect(view.root().getAttribute("data-state")).toBe("canceled"));
    expect(backend.calls.map((c) => c.action)).toEqual(["create", "abort"]);
    expect(view.part("status")!.textContent).toBe("Upload canceled.");
    expect(view.part("error")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect((view.part("input") as HTMLInputElement).disabled).toBe(false);
  });

  it("refuses a file over the limit without a network call, stating the limit", async () => {
    const backend = fakeBackend();
    const onError = vi.fn();
    const view = await render(uploader(backend, { maxFileSize: 10 * MiB, onError }));
    await choose(view, video(10 * MiB + 1));
    await waitFor(() => expect(view.part("error")).not.toBeNull());
    expect(view.part("error")!.getAttribute("role")).toBe("alert");
    expect(view.part("error")!.textContent).toBe("This file is too large. The limit is 10 MB.");
    expect(onError.mock.calls[0]![0].code).toBe("file_too_large");
    expect(backend.calls).toEqual([]);
    expect(backend.puts).toEqual([]);
    // Retrying the same file cannot help.
    expect(buttons(view)).toEqual([]);
  });

  it("refuses a file of the wrong type without a network call", async () => {
    const backend = fakeBackend();
    const view = await render(uploader(backend, { accept: "video/*" }));
    await choose(view, video(100, "notes.txt", "text/plain"));
    await waitFor(() => expect(view.part("error")).not.toBeNull());
    expect(view.part("error")!.textContent).toBe("This type of file is not accepted. Choose a video file.");
    expect(backend.calls).toEqual([]);
  });

  it("shows the app backend's refusal and offers Retry", async () => {
    const backend = fakeBackend({
      respond: (action) =>
        action === "create"
          ? json(403, { error: { code: "forbidden", message: "Uploads are closed on your plan." } })
          : undefined,
    });
    const onError = vi.fn();
    const view = await render(uploader(backend, { onError }));
    await choose(view, video(1000));
    await waitFor(() => expect(view.root().getAttribute("data-state")).toBe("error"));
    expect(view.part("error")!.textContent).toBe("Uploads are closed on your plan.");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: "forbidden", status: 403 });
    expect(view.part("status")!.textContent).toBe("Upload failed.");
    expect(buttons(view)).toEqual(["retry"]);
    // A 4xx is not retried by the core: one create, nothing signed or sent.
    expect(backend.calls.map((c) => c.action)).toEqual(["create"]);
  });

  it("shows the API's own message when the handler passes one through", async () => {
    const backend = fakeBackend({
      respond: (action) =>
        action === "create"
          ? json(402, { error: { code: "billing_past_due", message: "Your account has an unpaid invoice." } })
          : undefined,
    });
    const view = await render(uploader(backend));
    await choose(view, video(1000));
    await waitFor(() => expect(view.part("error")).not.toBeNull());
    expect(view.part("error")!.textContent).toBe("Your account has an unpaid invoice.");
  });

  it("explains a network failure, and Retry starts the same file again", async () => {
    let failing = true;
    const backend = fakeBackend({
      respond: (action) => {
        if (action === "create" && failing) throw new TypeError("Failed to fetch");
        return undefined;
      },
    });
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const view = await render(uploader(backend, { onError, onSuccess }));
    await choose(view, video(1000));
    await waitFor(() => expect(view.root().getAttribute("data-state")).toBe("error"));
    expect(onError.mock.calls[0]![0].code).toBe("network");
    expect(view.part("error")!.textContent).toBe(
      "The connection failed. Check your network, then choose Retry.",
    );

    failing = false;
    await click(view.part("retry"));
    await waitFor(() => expect(view.root().getAttribute("data-state")).toBe("success"));
    expect(view.part("error")).toBeNull();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("says so when the browser goes offline, and carries on when it is back", async () => {
    const backend = fakeBackend({ holdParts: true });
    const view = await render(uploader(backend));
    await choose(view, video(1000));
    await waitFor(() => expect(backend.pending()).toBe(1));
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    await waitFor(() => expect(view.root().getAttribute("data-state")).toBe("offline"));
    expect(view.part("status")!.textContent).toBe(
      "You are offline. The upload continues when the connection is back.",
    );
    expect(buttons(view)).toEqual(["pause", "cancel"]);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(backend.pending()).toBe(1));
    backend.release();
    await waitFor(() => expect(view.root().getAttribute("data-state")).toBe("success"));
  });

  it("pauses, never cancels, when it unmounts mid-upload", async () => {
    const backend = fakeBackend({ holdParts: true });
    const view = await render(uploader(backend));
    await choose(view, video(1000));
    await waitFor(() => expect(backend.pending()).toBe(1));
    await view.unmount();
    await waitFor(() => expect(backend.abortedPuts).toEqual([1]));
    expect(backend.calls.map((c) => c.action)).toEqual(["create"]);
  });

  it("uploads once under StrictMode", async () => {
    const backend = fakeBackend();
    const onSuccess = vi.fn();
    const view = await render(<StrictMode>{uploader(backend, { onSuccess })}</StrictMode>);
    await choose(view, video(1000));
    await waitFor(() => expect(view.root().getAttribute("data-state")).toBe("success"));
    expect(backend.calls.map((c) => c.action)).toEqual(["create", "complete"]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("starts an upload from a dropped file", async () => {
    const backend = fakeBackend();
    const view = await render(uploader(backend));
    const zone = view.part("dropzone")!;
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [video(1000, "dropped.mp4")] } });
    await act(async () => {
      zone.dispatchEvent(drop);
    });
    await waitFor(() => expect(view.root().getAttribute("data-state")).toBe("success"));
    expect(drop.defaultPrevented).toBe(true);
    expect((backend.calls[0]!.body.file as { name: string }).name).toBe("dropped.mp4");
  });
});
