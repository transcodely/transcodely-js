import { OutputFormat, Resolution, Transcodely, VideoCodec } from "@transcodely/sdk";

const client = new Transcodely({ apiKey: process.env.TRANSCODELY_API_KEY! });

const job = await client.jobs.create({
  inputUrl: "https://download.samplelib.com/mp4/sample-30s.mp4",
  outputs: [
    {
      type: OutputFormat.HLS,
      video: [
        { codec: VideoCodec.H264, resolution: Resolution.RESOLUTION_1080P },
        { codec: VideoCodec.H264, resolution: Resolution.RESOLUTION_720P },
        { codec: VideoCodec.H264, resolution: Resolution.RESOLUTION_480P },
      ],
    },
  ],
  metadata: { source: "01-create-job.ts" },
});

console.log("Created", job.id, "in status", job.status);
