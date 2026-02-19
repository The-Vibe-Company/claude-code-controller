import { generateSessionName } from "./names.js";

describe("generateSessionName", () => {
  it("returns a string with two words separated by a space", () => {
    const name = generateSessionName("test-session-id");
    const parts = name.split(" ");
    expect(parts).toHaveLength(2);
    expect(parts[0]!.length).toBeGreaterThan(0);
    expect(parts[1]!.length).toBeGreaterThan(0);
  });

  it("returns names where both words are capitalized", () => {
    for (let i = 0; i < 20; i++) {
      const name = generateSessionName(`session-${i}`);
      const [adj, noun] = name.split(" ");
      expect(adj![0]).toBe(adj![0]!.toUpperCase());
      expect(noun![0]).toBe(noun![0]!.toUpperCase());
    }
  });

  it("is deterministic — same session ID always produces the same name", () => {
    const id = "abc-123-def-456";
    const name1 = generateSessionName(id);
    const name2 = generateSessionName(id);
    const name3 = generateSessionName(id);
    expect(name1).toBe(name2);
    expect(name2).toBe(name3);
  });

  it("produces different names for different session IDs", () => {
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) {
      names.add(generateSessionName(`session-${i}`));
    }
    // With 1600 combinations, 50 different IDs should produce many distinct names
    expect(names.size).toBeGreaterThan(10);
  });
});
