/** SDK version. Bumped by release-please from package.json on each tag. */
export const SDK_VERSION = "0.3.1"; // x-release-please-version

/**
 * API version this SDK release is pinned to. Sent on every request as
 * `Transcodely-Version`. Customers can override per-client via the
 * `apiVersion` config option.
 */
export const API_VERSION = "2026-05-03";

/** Default base URL for the production Transcodely API. */
export const DEFAULT_BASE_URL = "https://api.transcodely.com";
