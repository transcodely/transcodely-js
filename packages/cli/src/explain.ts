/**
 * Plain-language second lines for the API's wire error codes.
 *
 * The API's own message is always printed first and is already written for a
 * human; this adds the bit a terminal user needs and a REST caller does not —
 * whether anything was created, and what they can actually do next. Codes we
 * do not recognise print nothing extra rather than a guess.
 *
 * Sourced from `api/internal/connect/errors.go` (the code → wire-string map)
 * and `api/internal/domain/apierror.go`.
 */
const HINTS: Record<string, string> = {
  hosting_provisioning_failed:
    "Nothing was created. Managed hosting is set up on an app's first video, and that setup failed — the same command is safe to run again.",
  billing_past_due:
    "The organization has an unpaid invoice. Settle it in the dashboard, then run this again.",
  outstanding_balance_exceeded:
    "The organization's unbilled balance is over its limit. Paying it unblocks the next request.",
  limit_exceeded:
    "The app is over its monthly spend limit. Raise the limit in the dashboard, or wait for the next billing period.",
  queue_limit_exceeded:
    "Too many jobs are already queued for this app. Existing jobs still run; try again once some finish.",
  intake_paused: "Transcodely is not accepting new work right now. Nothing is lost — try again shortly.",
  app_suspended: "This app is suspended. Reading still works; creating does not.",
  managed_delivery_not_provisioned:
    "This app's managed storage origin was archived, which provisioning cannot undo. Support has to restore it.",
  invalid_api_key: "Check the key, or run `transcodely login` again.",
  unauthenticated: "Check the key, or run `transcodely login` again.",
};

export function explain(code: string): string | undefined {
  return HINTS[code];
}
