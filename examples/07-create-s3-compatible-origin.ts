import { OriginPermission, Transcodely } from "@transcodely/sdk";

const client = new Transcodely({ apiKey: process.env.TRANSCODELY_API_KEY! });

// Any S3-compatible store (Hetzner Object Storage, Wasabi, DigitalOcean Spaces,
// MinIO, Backblaze B2) uses the `s3` provider plus an explicit endpoint.
// Transcodely switches to path-style addressing automatically; the region is
// still required because the AWS SDK uses it to sign requests.
const origin = await client.origins.create({
  name: "Hetzner Object Storage",
  permissions: [OriginPermission.READ, OriginPermission.WRITE],
  s3: {
    bucket: process.env.S3_BUCKET ?? "media",
    region: "fsn1", // Hetzner location code (fsn1, nbg1, hel1)
    endpoint: "https://fsn1.your-objectstorage.com",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  },
});

console.log("Created", origin.id, "for bucket", origin.s3?.bucket);

// Omit `endpoint` (and use an AWS region like "us-east-1") for Amazon S3.
