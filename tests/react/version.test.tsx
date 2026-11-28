import { version } from "react";
import { version as domVersion } from "react-dom";
import { describe, expect, it } from "vitest";

// Each vitest project aliases react/react-dom to one major. If an alias ever
// stopped applying, both projects would quietly test the same React.
describe("the React under test", () => {
  it("is the major this project was configured for", () => {
    const expected = process.env.EXPECTED_REACT_MAJOR;
    expect(expected === "18" || expected === "19").toBe(true);
    expect(version.split(".")[0]).toBe(expected);
    expect(domVersion.split(".")[0]).toBe(expected);
  });
});
