/**
 * Express receiver that verifies an incoming Transcodely webhook, narrows
 * the event by `type`, and acks. Run with `pnpm webhook-receiver`.
 *
 * Required env vars:
 *   TRANSCODELY_API_KEY    — only needed if you also call the API
 *   WEBHOOK_SECRET         — the `whsec_…` returned by webhookEndpoints.create
 *   PORT                   — optional, defaults to 4242
 */
import express from "express";

import {
  Transcodely,
  WebhookPayloadError,
  WebhookSignatureError,
  WebhookTimestampError,
} from "@transcodely/sdk";

const client = new Transcodely({ apiKey: process.env.TRANSCODELY_API_KEY ?? "" });
const secret = process.env.WEBHOOK_SECRET ?? "";
if (!secret) {
  console.error("WEBHOOK_SECRET is required");
  process.exit(1);
}

const app = express();

app.post(
  "/webhooks/transcodely",
  // Use raw() — the signature is computed over the literal request body,
  // so JSON.parse'ing first would change the bytes and break verification.
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sigHeader = req.header("transcodely-signature");
    if (!sigHeader) {
      res.status(400).send("missing transcodely-signature header");
      return;
    }

    try {
      const event = client.webhooks.constructEvent(req.body, sigHeader, secret);

      // `isKnownEvent` narrows to the closed union this SDK types precisely,
      // so each `case` below narrows `event.data` to the exact resource —
      // `event.data.id` / `.outputUrl` typecheck with no casts.
      if (client.webhooks.isKnownEvent(event)) {
        switch (event.type) {
          case "job.succeeded":
            console.log(`[${event.id}] job ${event.data.id} finished`);
            break;
          case "job.failed":
            console.warn(`[${event.id}] job ${event.data.id} failed`);
            break;
          case "output.ready":
            console.log(`[${event.id}] output ${event.data.id} ready: ${event.data.outputUrl}`);
            break;
          case "video.uploaded":
            console.log(`[${event.id}] video ${event.data.id} uploaded`);
            break;
          default:
            // Every other known event — `event.type` is still a precise
            // literal here, `event.data` a decoded resource.
            console.log(`[${event.id}] unhandled known type ${event.type}`);
        }
      } else {
        // Forward-compat: an event type added to the API after this SDK
        // release still verifies and parses; `event.data` is raw `unknown`.
        console.log(`[${event.id}] unknown future type ${event.type}`);
      }

      res.sendStatus(200);
    } catch (err) {
      if (err instanceof WebhookSignatureError) {
        res.status(400).send("invalid signature");
        return;
      }
      if (err instanceof WebhookTimestampError) {
        res.status(400).send("signature timestamp out of tolerance");
        return;
      }
      if (err instanceof WebhookPayloadError) {
        res.status(400).send("invalid envelope shape");
        return;
      }
      throw err;
    }
  },
);

const port = Number(process.env.PORT ?? "4242");
app.listen(port, () => {
  console.log(`Listening for Transcodely webhooks on http://localhost:${port}/webhooks/transcodely`);
});
