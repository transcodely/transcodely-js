import {
  AuthenticationError,
  InvalidRequestError,
  NotFoundError,
  RateLimitError,
  Transcodely,
  TranscodelyError,
} from "@transcodely/sdk";

const client = new Transcodely({ apiKey: process.env.TRANSCODELY_API_KEY! });

try {
  await client.jobs.get("job_does_not_exist");
} catch (err) {
  if (err instanceof NotFoundError) {
    console.log("Job not found, request id:", err.requestId);
  } else if (err instanceof AuthenticationError) {
    console.error("Auth failed — check your API key");
  } else if (err instanceof InvalidRequestError) {
    for (const v of err.errors) console.warn(`${v.field}: ${v.description}`);
  } else if (err instanceof RateLimitError) {
    console.warn(`Rate limited — retry after ${err.retryAfterMs}ms`);
  } else if (err instanceof TranscodelyError) {
    console.error("Transcodely error:", err.code, err.message);
  } else {
    throw err;
  }
}
