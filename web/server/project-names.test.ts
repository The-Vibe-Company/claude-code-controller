import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getName,
  setName,
  getAllNames,
  removeName,
  _resetForTest,
} from "./project-names.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "project-names-test-"));
  _resetForTest(join(tempDir, "project-names.json"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("project-names", () => {
  it("returns undefined for unknown project key", () => {
    expect(getName("/unknown/path")).toBeUndefined();
  });

  it("setName + getName round-trip", () => {
    setName("/home/user/my-project", "My Project");
    expect(getName("/home/user/my-project")).toBe("My Project");
  });

  it("persists to disk", () => {
    setName("/repo/path", "Project Name");
    const raw = readFileSync(join(tempDir, "project-names.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(data).toEqual({ "/repo/path": "Project Name" });
  });

  it("getAllNames returns a copy of all names", () => {
    setName("/repo/a", "Project A");
    setName("/repo/b", "Project B");
    const all = getAllNames();
    expect(all).toEqual({ "/repo/a": "Project A", "/repo/b": "Project B" });
    // Verify it's a copy (mutating doesn't affect internal state)
    all["/repo/c"] = "Project C";
    expect(getName("/repo/c")).toBeUndefined();
  });

  it("removeName deletes a name", () => {
    setName("/repo/path", "My Project");
    removeName("/repo/path");
    expect(getName("/repo/path")).toBeUndefined();
    const raw = readFileSync(join(tempDir, "project-names.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({});
  });

  it("overwrites existing name", () => {
    setName("/repo/path", "Old Name");
    setName("/repo/path", "New Name");
    expect(getName("/repo/path")).toBe("New Name");
  });

  it("creates parent directories if needed", () => {
    const nestedPath = join(tempDir, "nested", "dir", "names.json");
    _resetForTest(nestedPath);
    setName("/repo/path", "Deep Project");
    expect(getName("/repo/path")).toBe("Deep Project");
  });

  it("loads existing data from disk on first access", () => {
    // Write data to file before any module access
    writeFileSync(
      join(tempDir, "project-names.json"),
      JSON.stringify({ "/existing/path": "Pre-existing Project" }),
    );
    // Reset to re-read from the file
    _resetForTest(join(tempDir, "project-names.json"));
    expect(getName("/existing/path")).toBe("Pre-existing Project");
  });

  it("handles corrupt JSON gracefully", () => {
    writeFileSync(join(tempDir, "project-names.json"), "NOT VALID JSON");
    _resetForTest(join(tempDir, "project-names.json"));
    expect(getName("/any/path")).toBeUndefined();
  });
});
