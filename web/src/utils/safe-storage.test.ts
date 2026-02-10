import { describe, it, expect, beforeEach, vi } from "vitest";

describe("safe-storage", () => {
  beforeEach(() => {
    // Clear localStorage before each test
    if (typeof window !== "undefined") {
      window.localStorage.clear();
    }
  });

  it("getItem returns null for missing keys", async () => {
    const { safeStorage } = await import("./safe-storage");
    expect(safeStorage.getItem("non-existent-key")).toBeNull();
  });

  it("setItem and getItem round-trips correctly", async () => {
    const { safeStorage } = await import("./safe-storage");
    safeStorage.setItem("test-key", "test-value");
    expect(safeStorage.getItem("test-key")).toBe("test-value");
  });

  it("removeItem removes the key", async () => {
    const { safeStorage } = await import("./safe-storage");
    safeStorage.setItem("test-key", "test-value");
    expect(safeStorage.getItem("test-key")).toBe("test-value");
    safeStorage.removeItem("test-key");
    expect(safeStorage.getItem("test-key")).toBeNull();
  });

  it("fallback works when localStorage throws", async () => {
    if (typeof window === "undefined" || !window.localStorage) {
      // Skip this test in environments without window/localStorage
      return;
    }

    // Mock localStorage to throw
    const originalSetItem = window.localStorage.setItem;
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("localStorage is disabled");
    });

    // Force re-import to trigger fallback logic
    vi.resetModules();
    const { safeStorage } = await import("./safe-storage");

    // Should use in-memory fallback
    safeStorage.setItem("test-key", "test-value");
    expect(safeStorage.getItem("test-key")).toBe("test-value");
    safeStorage.removeItem("test-key");
    expect(safeStorage.getItem("test-key")).toBeNull();

    // Restore original
    window.localStorage.setItem = originalSetItem;
  });

  it("clear removes all items", async () => {
    const { safeStorage } = await import("./safe-storage");
    safeStorage.setItem("key1", "value1");
    safeStorage.setItem("key2", "value2");
    expect(safeStorage.length).toBeGreaterThanOrEqual(2);
    safeStorage.clear();
    expect(safeStorage.getItem("key1")).toBeNull();
    expect(safeStorage.getItem("key2")).toBeNull();
  });

  it("key returns key at index", async () => {
    const { safeStorage } = await import("./safe-storage");
    safeStorage.clear();
    safeStorage.setItem("key1", "value1");
    safeStorage.setItem("key2", "value2");
    const keys = [];
    for (let i = 0; i < safeStorage.length; i++) {
      keys.push(safeStorage.key(i));
    }
    expect(keys).toContain("key1");
    expect(keys).toContain("key2");
  });

  it("length returns correct count", async () => {
    const { safeStorage } = await import("./safe-storage");
    safeStorage.clear();
    expect(safeStorage.length).toBe(0);
    safeStorage.setItem("key1", "value1");
    expect(safeStorage.length).toBe(1);
    safeStorage.setItem("key2", "value2");
    expect(safeStorage.length).toBe(2);
    safeStorage.removeItem("key1");
    expect(safeStorage.length).toBe(1);
  });
});
