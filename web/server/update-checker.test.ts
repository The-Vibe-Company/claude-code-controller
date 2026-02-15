import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

let checker: typeof import("./update-checker.js");

beforeEach(async () => {
  vi.resetModules();
  mockFetch.mockReset();
  checker = await import("./update-checker.js");
});

afterEach(() => {
  checker.stopPeriodicCheck();
});

// ===========================================================================
// isNewerVersion
// ===========================================================================
describe("isNewerVersion", () => {
  it("returns true when major version is higher", () => {
    expect(checker.isNewerVersion("2.0.0", "1.0.0")).toBe(true);
  });

  it("returns true when minor version is higher", () => {
    expect(checker.isNewerVersion("1.1.0", "1.0.0")).toBe(true);
  });

  it("returns true when patch version is higher", () => {
    expect(checker.isNewerVersion("1.0.1", "1.0.0")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(checker.isNewerVersion("1.0.0", "1.0.0")).toBe(false);
  });

  it("returns false when version is lower", () => {
    expect(checker.isNewerVersion("1.0.0", "1.0.1")).toBe(false);
    expect(checker.isNewerVersion("0.9.0", "1.0.0")).toBe(false);
  });
});

// ===========================================================================
// getCurrentVersion
// ===========================================================================
describe("getCurrentVersion", () => {
  it("returns a semver string", () => {
    const version = checker.getCurrentVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ===========================================================================
// getUpdateState
// ===========================================================================
describe("getUpdateState", () => {
  it("returns initial state with current version and no latest version", () => {
    const state = checker.getUpdateState();
    expect(state.currentVersion).toBe(checker.getCurrentVersion());
    expect(state.latestVersion).toBeNull();
    expect(state.isServiceMode).toBe(false);
    expect(state.checking).toBe(false);
    expect(state.updateInProgress).toBe(false);
  });
});

// ===========================================================================
// checkForUpdate
// ===========================================================================
describe("checkForUpdate", () => {
  it("sets latestVersion when fetch succeeds", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ version: "99.0.0" }),
    });

    await checker.checkForUpdate();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/the-companion/latest",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
    const state = checker.getUpdateState();
    expect(state.latestVersion).toBe("99.0.0");
    expect(state.lastChecked).toBeGreaterThan(0);
  });

  it("handles fetch errors gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    await checker.checkForUpdate();

    const state = checker.getUpdateState();
    expect(state.latestVersion).toBeNull();
  });

  it("handles non-ok response gracefully", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await checker.checkForUpdate();

    const state = checker.getUpdateState();
    expect(state.latestVersion).toBeNull();
  });
});

// ===========================================================================
// isUpdateAvailable
// ===========================================================================
describe("isUpdateAvailable", () => {
  it("returns false when no latest version is set", () => {
    expect(checker.isUpdateAvailable()).toBe(false);
  });

  it("returns true when latest is newer than current", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ version: "99.0.0" }),
    });

    await checker.checkForUpdate();
    expect(checker.isUpdateAvailable()).toBe(true);
  });

  it("returns false when latest equals current", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ version: checker.getCurrentVersion() }),
    });

    await checker.checkForUpdate();
    expect(checker.isUpdateAvailable()).toBe(false);
  });
});

// ===========================================================================
// setServiceMode / setUpdateInProgress
// ===========================================================================
describe("state setters", () => {
  it("setServiceMode updates isServiceMode", () => {
    checker.setServiceMode(true);
    expect(checker.getUpdateState().isServiceMode).toBe(true);
    checker.setServiceMode(false);
    expect(checker.getUpdateState().isServiceMode).toBe(false);
  });

  it("setUpdateInProgress updates updateInProgress", () => {
    checker.setUpdateInProgress(true);
    expect(checker.getUpdateState().updateInProgress).toBe(true);
    checker.setUpdateInProgress(false);
    expect(checker.getUpdateState().updateInProgress).toBe(false);
  });
});
