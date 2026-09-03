import { describe, it, expect } from "vitest";
import { stripAnsi } from "../../src/ingestion/ansiStripper";

describe("ansiStripper", () => {
  it("should remove basic ansi colors", () => {
    const raw = "\u001b[31mHello\u001b[0m World";
    const cleaned = stripAnsi(raw);
    expect(cleaned).toBe("Hello World");
  });

  it("should remove complex formatting codes", () => {
    const raw = "\u001b[1;31mBold Red\u001b[0m \u001b[4mUnderlined\u001b[0m";
    const cleaned = stripAnsi(raw);
    expect(cleaned).toBe("Bold Red Underlined");
  });

  it("should return identical string if no ansi codes present", () => {
    const raw = "Plain text";
    const cleaned = stripAnsi(raw);
    expect(cleaned).toBe(raw);
  });
});
