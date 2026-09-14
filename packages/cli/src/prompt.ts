/**
 * Reading a secret from the terminal without echoing it.
 *
 * readline writes every keystroke back to its `output`; swapping that writer
 * for one that drops everything while the answer is pending is the standard way
 * to mute it. `_writeToOutput` is an undocumented Node internal, though, so the
 * assignment is guarded: if a future Node renames or removes it the write would
 * land on nothing and the key would echo into the terminal and the scrollback —
 * silently, with every test still green. A secret's only safe failure is a
 * visible refusal, so that is what happens instead.
 *
 * The readline interface is injected so the guard and the muting wiring can be
 * tested. What still has no test is real readline's behaviour: that needs a pty.
 */

import { createInterface } from "node:readline/promises";

export interface SecretReadline {
  question(prompt: string): Promise<string>;
  close(): void;
  _writeToOutput?: (text: string) => void;
  output: { write(text: string): unknown };
}

export type ReadlineFactory = () => SecretReadline;

const defaultFactory: ReadlineFactory = () =>
  createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  }) as unknown as SecretReadline;

export async function promptSecret(
  prompt: string,
  factory: ReadlineFactory = defaultFactory,
  onClose: () => void = () => process.stderr.write("\n"),
): Promise<string> {
  const rl = factory();
  if (typeof rl._writeToOutput !== "function") {
    rl.close();
    throw new Error(
      "this Node build cannot mute the terminal echo, so the key would be printed as you type it — " +
        "pass --api-key, or pipe the key on stdin instead",
    );
  }
  let muted = false;
  rl._writeToOutput = (text: string) => {
    if (!muted) rl.output.write(text);
  };
  const answer = rl.question(prompt);
  muted = true;
  try {
    return await answer;
  } finally {
    rl.close();
    onClose();
  }
}
