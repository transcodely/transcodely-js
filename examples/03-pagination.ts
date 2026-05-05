import { Transcodely } from "transcodely";

const client = new Transcodely({ apiKey: process.env.TRANSCODELY_API_KEY! });

let count = 0;
for await (const job of client.jobs.list({ pagination: { limit: 50 } }).autoPage()) {
  count++;
  console.log(`${count}. ${job.id} ${job.status}`);
  if (count >= 200) break; // safety cap
}

console.log(`\nTotal seen: ${count}`);
