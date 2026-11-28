// @vitest-environment node
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TranscodelyUploader, useTranscodelyUpload } from "../../src/react/index.js";

function Headless() {
  const { state, progress } = useTranscodelyUpload({ endpoint: "/api/upload" });
  return (
    <span>
      {state} {progress.percent}
    </span>
  );
}

// Server rendering (Next.js app router, Remix): no window, no document, no
// indexedDB. The modules must import and render without touching any of them.
describe("server rendering", () => {
  it("runs with no DOM at all", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
  });

  it("renders the component idle", () => {
    const html = renderToString(<TranscodelyUploader endpoint="/api/upload" accept="video/*" />);
    expect(html).toContain('data-transcodely-uploader=""');
    expect(html).toContain('data-state="idle"');
    expect(html).toContain('data-part="dropzone"');
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="video/*"');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('data-part="progress"');
  });

  it("renders the hook idle", () => {
    expect(renderToString(<Headless />)).toBe("<span>idle<!-- --> <!-- -->0</span>");
  });
});
