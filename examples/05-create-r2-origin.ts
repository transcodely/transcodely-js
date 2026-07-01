import {
  OriginPermission,
  R2Jurisdiction,
  Transcodely,
} from "@transcodely/sdk";

const client = new Transcodely({ apiKey: process.env.TRANSCODELY_API_KEY! });

const origin = await client.origins.create({
  name: "My R2 Origin",
  permissions: [OriginPermission.READ, OriginPermission.WRITE],
  r2: {
    bucket: process.env.R2_BUCKET ?? "media",
    accountId: process.env.R2_ACCOUNT_ID!,
    jurisdiction: R2Jurisdiction.DEFAULT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  },
});

console.log("Created", origin.id, "for bucket", origin.r2?.bucket);

/*
 * Alternative: an explicit endpoint URL (custom domain bound to the bucket, or
 * a jurisdiction not yet enumerated in R2Jurisdiction). Provide either
 * accountId or endpoint — never both.
 *
 * await client.origins.create({
 *   name: "My R2 Origin (custom endpoint)",
 *   permissions: [OriginPermission.READ, OriginPermission.WRITE],
 *   r2: {
 *     bucket: "media",
 *     endpoint: "https://media.example.com",
 *     credentials: {
 *       accessKeyId: process.env.R2_ACCESS_KEY_ID!,
 *       secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
 *     },
 *   },
 * });
 */
