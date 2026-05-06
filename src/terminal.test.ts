import { describe, expect, it } from "vitest";
import { shouldUseHeadlessMode } from "./terminal.js";

function stream(isTTY: boolean | undefined): NodeJS.WriteStream {
  return { isTTY } as NodeJS.WriteStream;
}

describe("shouldUseHeadlessMode", () => {
  it("keeps the Ink UI when stdin and stdout are TTYs", () => {
    expect(shouldUseHeadlessMode(stream(true), stream(true))).toBe(false);
  });

  it("falls back when stdin is not a TTY", () => {
    expect(shouldUseHeadlessMode(stream(false), stream(true))).toBe(true);
  });

  it("falls back when stdout is not a TTY", () => {
    expect(shouldUseHeadlessMode(stream(true), stream(false))).toBe(true);
  });
});
