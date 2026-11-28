/** CLI version. Bumped by release-please from packages/cli/package.json. */
export const CLI_VERSION = "0.1.1"; // x-release-please-version

/**
 * Set at build time by the root `tsup.bin.config.ts` to the version of the
 * @transcodely/sdk package this copy ships inside, and undefined in the
 * standalone `transcodely` build. The SDK and the CLI release separately, so
 * the CLI number alone cannot say which build a user is running.
 */
declare const __TRANSCODELY_SDK_VERSION__: string | undefined;

/** What `--version` prints: the CLI version, plus the SDK's when bundled in it. */
export const VERSION_LINE =
  typeof __TRANSCODELY_SDK_VERSION__ === "string"
    ? `${CLI_VERSION} (@transcodely/sdk ${__TRANSCODELY_SDK_VERSION__})`
    : CLI_VERSION;
