/**
 * Test harness for the React layer: a fake app backend speaking the browser
 * upload wire protocol (DESIGN.md), a fake storage endpoint for part PUTs, and
 * a tiny render/act helper over react-dom/client. Runs in happy-dom; nothing
 * touches the network.
 */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { partSizeFor } from "../../src/browser-upload/index.js";

export const ENDPOINT = "/api/transcodely/upload";
export const VIDEO_ID = "vid_a1b2c3d4e5f6g7";
const STORAGE = "https://storage.test/part/";

export interface Call {
  action: string;
  body: Record<string, unknown>;
}

export interface FakeBackendOptions {
  /** Return a Response to override the default for that endpoint action. */
  respond?: (action: string, body: Record<string, unknown>) => Response | undefined;
  /** Part PUTs wait for `release()` instead of answering at once. */
  holdParts?: boolean;
}

export interface FakeBackend {
  fetch: typeof fetch;
  calls: Call[];
  puts: number[];
  /** Part PUTs whose request signal was aborted (pause, unmount, cancel). */
  abortedPuts: number[];
  /** Lets every held part PUT answer, and the ones after it too. */
  release(): void;
  /** Lets exactly one held part PUT answer. */
  releaseOne(): boolean;
  pending(): number;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function fakeBackend(options: FakeBackendOptions = {}): FakeBackend {
  const calls: Call[] = [];
  const puts: number[] = [];
  const abortedPuts: number[] = [];
  const held: (() => void)[] = [];
  let holding = options.holdParts ?? false;
  let totalParts = 1;

  const urls = (numbers: number[]) => numbers.map((n) => ({ part_number: n, url: `${STORAGE}${n}` }));
  const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

  const endpoint = (action: string, body: Record<string, unknown>): Response => {
    const override = options.respond?.(action, body);
    if (override) return override;
    switch (action) {
      case "create": {
        const file = body.file as { size: number };
        const partSize = partSizeFor(file.size);
        totalParts = Math.max(1, Math.ceil(file.size / partSize));
        return json(200, {
          ticket: "t.sig",
          video_id: VIDEO_ID,
          upload_id: "upl_1",
          part_size: partSize,
          total_parts: totalParts,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          parts: urls(Array.from({ length: Math.min(totalParts, 50) }, (_, i) => i + 1)),
          urls_expire_at: inAnHour(),
        });
      }
      case "sign_parts":
        return json(200, { parts: urls(body.part_numbers as number[]), urls_expire_at: inAnHour() });
      case "complete":
        return json(200, { video_id: VIDEO_ID, status: "processing" });
      case "abort":
        return json(200, {});
      default:
        return json(400, { error: { code: "invalid_request", message: "Unknown action." } });
    }
  };

  const put = (n: number, signal: AbortSignal | null | undefined): Promise<Response> =>
    new Promise((resolve, reject) => {
      const abort = () => {
        abortedPuts.push(n);
        const at = held.indexOf(answer);
        if (at >= 0) held.splice(at, 1);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      const answer = () => {
        if (signal?.aborted) return;
        signal?.removeEventListener("abort", abort);
        puts.push(n);
        resolve(new Response(null, { status: 200, headers: { ETag: `"etag-${n}"` } }));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (holding) held.push(answer);
      else queueMicrotask(answer);
    });

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(STORAGE)) return put(Number(url.slice(STORAGE.length)), init?.signal);
    if (url.endsWith(ENDPOINT) && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ action: String(body.action), body });
      return endpoint(String(body.action), body);
    }
    throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
  };

  return {
    fetch: fetchImpl as typeof fetch,
    calls,
    puts,
    abortedPuts,
    release() {
      holding = false;
      held.splice(0).forEach((answer) => answer());
    },
    releaseOne() {
      const answer = held.shift();
      answer?.();
      return Boolean(answer);
    },
    pending: () => held.length,
  };
}

/** A File of `size` bytes. */
export function video(size: number, name = "talk.mp4", type = "video/mp4"): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: 1_700_000_000_000 });
}

export const MiB = 1024 * 1024;

export interface Rendered {
  container: HTMLElement;
  part(name: string): HTMLElement | null;
  root(): HTMLElement;
  rerender(ui: ReactElement): Promise<void>;
  unmount(): Promise<void>;
}

const mounted: Root[] = [];

export async function render(ui: ReactElement): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(ui));
  return {
    container,
    part: (name) => container.querySelector(`[data-part="${name}"]`),
    root: () => container.querySelector("[data-transcodely-uploader]") as HTMLElement,
    rerender: async (next) => act(async () => root.render(next)),
    unmount: async () => act(async () => root.unmount()),
  };
}

export async function cleanup(): Promise<void> {
  for (const root of mounted.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
}

/** Retries `assertion` while letting React and the uploader make progress. */
export async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await act(() => new Promise((r) => setTimeout(r, 5)));
    }
  }
}

/** Picks `file` in the component's file input, as a user would. */
export async function choose(view: Rendered, file: File): Promise<void> {
  const input = view.part("input") as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error("no element to click");
  await act(async () => (el as HTMLElement).click());
}

/** The control buttons currently shown, by data-part. */
export function buttons(view: Rendered): string[] {
  return [...view.container.querySelectorAll("button[data-part]")].map((b) => b.getAttribute("data-part")!);
}
