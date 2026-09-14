import { describe, expect, it } from "vitest";

import { promptSecret, type SecretReadline } from "../src/prompt.js";

/**
 * A stand-in for readline that behaves the way readline does: it echoes every
 * keystroke through `_writeToOutput` while the question is pending. That is
 * enough to prove the muting is wired and armed before the answer resolves.
 * Real readline's own behaviour still needs a pty and is not covered here.
 */
function fakeReadline(
  typed: string,
  opts: { supportsMuting?: boolean } = {},
): { rl: SecretReadline; written: string[]; closed: () => number } {
  const written: string[] = [];
  let closes = 0;
  const rl: SecretReadline = {
    output: {
      write(text: string) {
        written.push(text);
        return true;
      },
    },
    close() {
      closes++;
    },
    question(prompt: string) {
      // Modelled on real readline: the prompt is echoed synchronously inside
      // question(), and the keystrokes arrive later, as the user types. That
      // ordering is exactly what the muting relies on.
      rl._writeToOutput?.(prompt);
      return new Promise<string>((resolve) => {
        setTimeout(() => {
          for (const char of typed) rl._writeToOutput?.(char);
          resolve(typed);
        }, 0);
      });
    },
  };
  if (opts.supportsMuting !== false) rl._writeToOutput = () => undefined;
  return { rl, written, closed: () => closes };
}

describe("promptSecret", () => {
  it("returns the answer and never echoes the typed characters", async () => {
    const { rl, written, closed } = fakeReadline("ak_secret_key");
    const answer = await promptSecret("API key: ", () => rl, () => undefined);
    expect(answer).toBe("ak_secret_key");
    // The prompt is written; not one character of the key is.
    expect(written.join("")).toBe("API key: ");
    expect(closed()).toBe(1);
  });

  it("refuses rather than echoing when the Node internal it relies on is gone", async () => {
    // If `_writeToOutput` ever disappears, assigning it becomes an inert
    // property write and the key would be printed as it is typed — silently.
    // A visible refusal is the only safe failure for a secret.
    const { rl, closed } = fakeReadline("ak_secret_key", { supportsMuting: false });
    await expect(promptSecret("API key: ", () => rl, () => undefined)).rejects.toThrow(
      /cannot mute the terminal echo/,
    );
    expect(closed()).toBe(1);
  });

  it("closes the interface even when the question rejects", async () => {
    let closes = 0;
    const rl: SecretReadline = {
      output: { write: () => true },
      close: () => {
        closes++;
      },
      _writeToOutput: () => undefined,
      question: () => Promise.reject(new Error("stdin closed")),
    };
    await expect(promptSecret("API key: ", () => rl, () => undefined)).rejects.toThrow(
      "stdin closed",
    );
    expect(closes).toBe(1);
  });
});
