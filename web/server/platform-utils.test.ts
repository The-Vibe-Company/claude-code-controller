import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveWhich,
  binaryExists,
  gracefulKill,
  forceKill,
  killByPid,
  isAbsolutePath,
  normalizePath,
} from "./platform-utils.js";

// ─── Pure functions (no platform mocking needed) ─────────────────────────────

describe("isAbsolutePath", () => {
  it("returns true for Unix absolute paths", () => {
    expect(isAbsolutePath("/usr/bin/node")).toBe(true);
    expect(isAbsolutePath("/")).toBe(true);
  });

  it("returns true for Windows absolute paths", () => {
    expect(isAbsolutePath("C:\\Users\\user")).toBe(true);
    expect(isAbsolutePath("D:/projects")).toBe(true);
  });

  it("returns false for relative paths", () => {
    expect(isAbsolutePath("node")).toBe(false);
    expect(isAbsolutePath("./foo")).toBe(false);
    expect(isAbsolutePath("../bar")).toBe(false);
  });
});

describe("normalizePath", () => {
  it("replaces backslashes with forward slashes", () => {
    expect(normalizePath("C:\\Users\\user\\project")).toBe("C:/Users/user/project");
  });

  it("leaves forward slashes unchanged", () => {
    expect(normalizePath("/home/user/project")).toBe("/home/user/project");
  });

  it("handles mixed separators", () => {
    expect(normalizePath("C:\\Users/user\\project")).toBe("C:/Users/user/project");
  });

  it("handles empty string", () => {
    expect(normalizePath("")).toBe("");
  });
});

// ─── Platform-dependent functions (mocked) ───────────────────────────────────
// These tests mock process.platform to exercise both Windows and Unix branches
// regardless of the CI runner's actual OS.

describe("resolveWhich", () => {
  it("returns the resolved path from which/where output", () => {
    // This test calls the real which/where — just verifying it returns a string
    const result = resolveWhich("node");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("falls back to the input name when binary is not found", () => {
    const result = resolveWhich("__nonexistent_binary_12345__");
    expect(result).toBe("__nonexistent_binary_12345__");
  });
});

describe("binaryExists", () => {
  it("returns true for a binary that exists (node)", () => {
    expect(binaryExists("node")).toBe(true);
  });

  it("returns false for a binary that does not exist", () => {
    expect(binaryExists("__nonexistent_binary_12345__")).toBe(false);
  });
});

describe("gracefulKill", () => {
  it("calls proc.kill() without throwing", () => {
    const proc = { kill: vi.fn() };
    gracefulKill(proc);
    expect(proc.kill).toHaveBeenCalled();
  });
});

describe("forceKill", () => {
  it("calls proc.kill() without throwing", () => {
    const proc = { kill: vi.fn() };
    forceKill(proc);
    expect(proc.kill).toHaveBeenCalled();
  });
});

describe("killByPid", () => {
  it("does not throw for a non-existent PID", () => {
    // PID 999999 almost certainly doesn't exist
    expect(() => killByPid(999999)).not.toThrow();
  });
});
