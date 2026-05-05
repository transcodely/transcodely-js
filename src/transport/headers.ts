import { SDK_VERSION } from "../version.js";

const PLATFORM = (() => {
  if (typeof process !== "undefined" && process.versions?.node) {
    return `Node.js ${process.version} ${process.platform} ${process.arch}`;
  }
  if (typeof navigator !== "undefined") {
    return `Browser ${navigator.userAgent}`;
  }
  return "unknown";
})();

const LANG_VERSION = (() => {
  if (typeof process !== "undefined" && process.versions?.node) {
    return process.versions.node;
  }
  return "browser";
})();

export function userAgent(): string {
  if (typeof process !== "undefined" && process.versions?.node) {
    return `Transcodely/${SDK_VERSION} typescript Node/${process.versions.node}`;
  }
  return `Transcodely/${SDK_VERSION} typescript browser`;
}

export function clientUserAgentJson(): string {
  return JSON.stringify({
    lang: "typescript",
    lang_version: LANG_VERSION,
    platform: PLATFORM,
    publisher: "transcodely",
    version: SDK_VERSION,
  });
}

/** Best-effort UUID v4. Falls back to a random hex string if `crypto` is absent. */
export function uuidv4(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h: string[] = [];
  for (let i = 0; i < 16; i++) h.push(bytes[i]!.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}
