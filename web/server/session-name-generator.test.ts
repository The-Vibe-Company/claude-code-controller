import { describe, expect, it } from "vitest";
import { generateSessionName } from "./session-name-generator.js";

describe("generateSessionName", () => {
  it("returns two title-cased words", () => {
    const name = generateSessionName("test-session-id");
    expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it("is deterministic for the same session id", () => {
    const id = "same-session-id";
    expect(generateSessionName(id)).toBe(generateSessionName(id));
  });

  it("produces variety across ids", () => {
    const names = new Set<string>();
    for (let i = 0; i < 30; i++) {
      names.add(generateSessionName(`session-${i}`));
    }
    expect(names.size).toBeGreaterThan(1);
  });
});
