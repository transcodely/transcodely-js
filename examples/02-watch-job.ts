import { JobStatus, Transcodely } from "@transcodely/sdk";

const client = new Transcodely({ apiKey: process.env.TRANSCODELY_API_KEY! });

const jobId = process.argv[2];
if (!jobId) {
  console.error("usage: tsx 02-watch-job.ts <job_id>");
  process.exit(1);
}

const ac = new AbortController();
setTimeout(() => ac.abort(), 10 * 60 * 1000); // give up after 10 minutes

for await (const event of client.jobs.watch(jobId, { signal: ac.signal })) {
  const job = event.job;
  if (!job) continue;
  console.log(`[${job.status}] progress=${job.progress}%`);
  if (
    job.status === JobStatus.COMPLETED ||
    job.status === JobStatus.FAILED ||
    job.status === JobStatus.CANCELED
  ) {
    console.log("terminal:", JobStatus[job.status]);
    break;
  }
}
