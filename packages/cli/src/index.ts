/**
 * Process entry point. Everything interesting is in `main.ts`; this file only
 * binds it to the real stdin/stdout/argv and sets the exit code.
 */

import { createInterface } from "node:readline/promises";

import { defaultStore } from "./credentials.js";
import { run } from "./main.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads a secret from the terminal without echoing it.
 *
 * readline writes each keystroke back to `output`; swapping that writer for one
 * that drops everything while the answer is pending is the standard way to mute
 * it. The prompt and the closing newline go to stderr so stdout stays a clean
 * data channel even here.
 */
async function promptSecret(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const internals = rl as unknown as {
    _writeToOutput?: (text: string) => void;
    output: NodeJS.WritableStream;
  };
  let muted = false;
  internals._writeToOutput = (text: string) => {
    if (!muted) internals.output.write(text);
  };
  const answer = rl.question(prompt);
  muted = true;
  try {
    return await answer;
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
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
