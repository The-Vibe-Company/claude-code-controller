import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock fs.readFileSync to control versions
const mockReadFileSync = vi.fn();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: unknown[]) => mockReadFileSync(...args) };
});

let checker: typeof import("./update-checker.js");

beforeEach(async () => {
  vi.resetModules();
  mockFetch.mockReset();
  mockReadFileSync.mockReset();
  // Default: return version "0.1.0" for wilco, "0.29.0" for companion
  mockReadFileSync.mockImplementation((filePath: string) => {
    if (String(filePath).includes("companion")) {
      return JSON.stringify({ version: "0.29.0" });
    }
    return JSON.stringify({ version: "0.1.0" });
  });
  checker = await import("./update-checker.js");
});

afterEach(() => {
  checker.stopPeriodicCheck();
});

// ── isNewerVersion ──────────────────────────────────────────────────────────
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
  });
  it("strips leading v from tag names", () => {
    expect(checker.isNewerVersion("v2.0.0", "1.0.0")).toBe(true);
    expect(checker.isNewerVersion("v1.0.0", "v1.0.0")).toBe(false);
  });
});

// ── getUpdateState ──────────────────────────────────────────────────────────
describe("getUpdateState", () => {
  it("returns initial dual-repo state", () => {
    const state = checker.getUpdateState();
    expect(state.wilco.current).toBe("0.1.0");
    expect(state.wilco.latest).toBeNull();
    expect(state.companion.current).toBe("0.29.0");
    expect(state.companion.latest).toBeNull();
    expect(state.updateInProgress).toBe(false);
  });
});

// ── checkForUpdate ──────────────────────────────────────────────────────────
describe("checkForUpdate", () => {
  it("fetches both repos from GitHub releases API", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v0.2.0" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v0.31.0" }),
      });

    await checker.checkForUpdate();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("rc-international/wilco"),
      expect.any(Object),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("rc-int/companion"),
      expect.any(Object),
    );

    const state = checker.getUpdateState();
    expect(state.wilco.latest).toBe("0.2.0");
    expect(state.companion.latest).toBe("0.31.0");
    expect(state.lastChecked).toBeGreaterThan(0);
  });

  it("handles fetch errors gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    await checker.checkForUpdate();

    const state = checker.getUpdateState();
    expect(state.wilco.latest).toBeNull();
    expect(state.companion.latest).toBeNull();
  });

  it("handles partial failure (one repo ok, one fails)", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v0.2.0" }),
      })
      .mockRejectedValueOnce(new Error("Not found"));

    await checker.checkForUpdate();

    const state = checker.getUpdateState();
    expect(state.wilco.latest).toBe("0.2.0");
    expect(state.companion.latest).toBeNull();
  });

  it("includes GITHUB_TOKEN as Bearer header when set", async () => {
    process.env.GITHUB_TOKEN = "ghp_test123";
    vi.resetModules();
    checker = await import("./update-checker.js");

    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false });

    await checker.checkForUpdate();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_test123",
        }),
      }),
    );

    delete process.env.GITHUB_TOKEN;
  });
});

// ── isUpdateAvailable ───────────────────────────────────────────────────────
describe("isUpdateAvailable", () => {
  it("returns false when no latest versions are set", () => {
    expect(checker.isUpdateAvailable()).toBe(false);
  });

  it("returns true when wilco has newer version", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v99.0.0" }),
      })
      .mockResolvedValueOnce({ ok: false });

    await checker.checkForUpdate();
    expect(checker.isUpdateAvailable()).toBe(true);
  });

  it("returns true when companion has newer version", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v99.0.0" }),
      });

    await checker.checkForUpdate();
    expect(checker.isUpdateAvailable()).toBe(true);
  });

  it("returns false when both are up to date", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v0.1.0" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v0.29.0" }),
      });

    await checker.checkForUpdate();
    expect(checker.isUpdateAvailable()).toBe(false);
  });
});

// ── setUpdateInProgress ─────────────────────────────────────────────────────
describe("setUpdateInProgress", () => {
  it("updates updateInProgress state", () => {
    checker.setUpdateInProgress(true);
    expect(checker.getUpdateState().updateInProgress).toBe(true);
    checker.setUpdateInProgress(false);
    expect(checker.getUpdateState().updateInProgress).toBe(false);
  });
});
