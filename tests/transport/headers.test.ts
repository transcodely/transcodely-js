import { describe, expect, it } from "vitest";

import { clientUserAgentJson, userAgent, uuidv4 } from "../../src/transport/headers.js";
import { SDK_VERSION } from "../../src/version.js";

describe("userAgent", () => {
  it("includes the SDK version and 'typescript'", () => {
    const ua = userAgent();
    expect(ua).toContain(`Transcodely/${SDK_VERSION}`);
    expect(ua).toContain("typescript");
  });
});

describe("clientUserAgentJson", () => {
  it("returns a parseable JSON object with the expected keys", () => {
    const parsed = JSON.parse(clientUserAgentJson()) as Record<string, unknown>;
    expect(parsed.lang).toBe("typescript");
    expect(parsed.publisher).toBe("transcodely");
    expect(parsed.version).toBe(SDK_VERSION);
    expect(typeof parsed.lang_version).toBe("string");
    expect(typeof parsed.platform).toBe("string");
  });
});

describe("uuidv4", () => {
  const RFC4122 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it("matches the RFC 4122 v4 format", () => {
    for (let i = 0; i < 50; i++) {
      const id = uuidv4();
      expect(id).toMatch(RFC4122);
    }
  });

  it("produces distinct values across calls", () => {
    const set = new Set(Array.from({ length: 100 }, () => uuidv4()));
    expect(set.size).toBe(100);
  });
});
