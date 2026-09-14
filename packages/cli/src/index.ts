/**
 * Process entry point. Everything interesting is in `main.ts`; this file only
 * binds it to the real stdin/stdout/argv and sets the exit code.
 */

import { defaultStore } from "./credentials.js";
import { run } from "./main.js";
import { promptSecret } from "./prompt.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

const store = await defaultStore(process.env, undefined, (message) =>
  process.stderr.write(`transcodely: ${message}\n`),
);

process.exitCode = await run({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isTTY: Boolean(process.stdout.isTTY),
  stdinIsTTY: Boolean(process.stdin.isTTY),
  readStdin,
  promptSecret,
  store,
});
