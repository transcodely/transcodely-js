/**
 * Exit codes. Kept in one place because they are the CLI's real contract with
 * scripts: 0 worked, 1 the API said no, 2 you asked for something impossible.
 */
export const EXIT_OK = 0;
export const EXIT_API_ERROR = 1;
export const EXIT_USAGE = 2;

/** A mistake in the command line. Never the API's fault. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
