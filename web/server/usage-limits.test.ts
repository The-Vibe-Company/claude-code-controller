import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
}));

// Mock global fetch at the module level (persists across tests)
const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Module under test — re-imported each time to reset module-level cache
// ---------------------------------------------------------------------------
let mod: typeof import("./usage-limits.js");
const originalPlatform = process.platform;

beforeEach(async () => {
  vi.resetModules();
  mockExecSync.mockReset();
  mockExecFileSync.mockReset();
  mockFetch.mockReset();
  mod = await import("./usage-limits.js");
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_TOKEN = "sk-ant-fake-token-123";

function makeCredentialsJson(token: string, opts?: { expired?: boolean }): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      refreshToken: "sk-ant-ort01-fake-refresh-token",
      expiresAt: opts?.expired ? Date.now() - 1000 : Date.now() + 3_600_000,
    },
  });
}

function makeCredentialsHex(token: string): string {
  return Buffer.from(makeCredentialsJson(token), "utf-8").toString("hex");
}

function makeFetchResponse(body: object, ok = true) {
  return Promise.resolve({
    ok,
    json: () => Promise.resolve(body),
  });
}

const SAMPLE_LIMITS = {
  five_hour: { utilization: 42, resets_at: "2025-01-01T12:00:00Z" },
  seven_day: { utilization: 15, resets_at: null },
  extra_usage: null,
};

// ===========================================================================
// getCredentials
// ===========================================================================
describe("getCredentials", () => {
  it("extracts token from plain JSON output", () => {
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    expect(mod.getCredentials()).toBe(SAMPLE_TOKEN);
  });

  it("extracts token from hex-encoded output", () => {
    mockExecSync.mockReturnValue(makeCredentialsHex(SAMPLE_TOKEN));
    expect(mod.getCredentials()).toBe(SAMPLE_TOKEN);
  });

  it("returns null when execSync throws (e.g. not on macOS)", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("security: command not found");
    });
    expect(mod.getCredentials()).toBeNull();
  });

  it("returns null when JSON has no claudeAiOauth field", () => {
    mockExecSync.mockReturnValue(JSON.stringify({ other: "data" }));
    expect(mod.getCredentials()).toBeNull();
  });

  it("returns token even when format doesn't match sk-ant-*", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "not-a-valid-token" } }),
    );
    expect(mod.getCredentials()).toBe("not-a-valid-token");
  });
});

// ===========================================================================
// getCredentials — Windows path
// ===========================================================================
describe("getCredentials (Windows)", () => {
  let tempDir: string;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    tempDir = mkdtempSync(join(tmpdir(), "usage-limits-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads token from credentials file on Windows", async () => {
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".credentials.json"),
      makeCredentialsJson(SAMPLE_TOKEN),
    );
    process.env.USERPROFILE = tempDir;

    // Re-import to pick up the mocked platform
    vi.resetModules();
    mockFetch.mockReset();
    const winMod = await import("./usage-limits.js");
    expect(winMod.getCredentials()).toBe(SAMPLE_TOKEN);

    delete process.env.USERPROFILE;
  });

  it("returns null when credentials file does not exist on Windows", async () => {
    process.env.USERPROFILE = tempDir;

    vi.resetModules();
    const winMod = await import("./usage-limits.js");
    expect(winMod.getCredentials()).toBeNull();

    delete process.env.USERPROFILE;
  });

  it("returns null when credentials file has invalid JSON on Windows", async () => {
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, ".credentials.json"), "NOT VALID JSON{{{");
    process.env.USERPROFILE = tempDir;

    vi.resetModules();
    const winMod = await import("./usage-limits.js");
    expect(winMod.getCredentials()).toBeNull();

    delete process.env.USERPROFILE;
  });
});

// ===========================================================================
// fetchUsageLimits
// ===========================================================================
describe("fetchUsageLimits", () => {
  it("returns parsed limits on success", async () => {
    mockFetch.mockReturnValue(makeFetchResponse(SAMPLE_LIMITS));

    const result = await mod.fetchUsageLimits(SAMPLE_TOKEN);
    expect(result).toEqual(SAMPLE_LIMITS);

    // Verify correct headers
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: `Bearer ${SAMPLE_TOKEN}`,
        }),
      }),
    );
  });

  it("returns null on non-ok response", async () => {
    mockFetch.mockReturnValue(makeFetchResponse({}, false));
    const result = await mod.fetchUsageLimits(SAMPLE_TOKEN);
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    const result = await mod.fetchUsageLimits(SAMPLE_TOKEN);
    expect(result).toBeNull();
  });

  it("normalizes missing fields to null", async () => {
    mockFetch.mockReturnValue(
      makeFetchResponse({ five_hour: { utilization: 10, resets_at: null } }),
    );
    const result = await mod.fetchUsageLimits(SAMPLE_TOKEN);
    expect(result).toEqual({
      five_hour: { utilization: 10, resets_at: null },
      seven_day: null,
      extra_usage: null,
    });
  });
});

// ===========================================================================
// getUsageLimits (orchestrator with cache)
// ===========================================================================
describe("getUsageLimits", () => {
  const EMPTY = { five_hour: null, seven_day: null, extra_usage: null };

  it("returns empty when no credentials are available", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("no keychain");
    });
    const result = await mod.getUsageLimits();
    expect(result).toEqual(EMPTY);
  });

  it("returns limits and caches the result", async () => {
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    mockFetch.mockReturnValue(makeFetchResponse(SAMPLE_LIMITS));

    const first = await mod.getUsageLimits();
    expect(first).toEqual(SAMPLE_LIMITS);

    // Second call should use cache — fetch should not be called again
    const second = await mod.getUsageLimits();
    expect(second).toEqual(SAMPLE_LIMITS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes cache after TTL expires", async () => {
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    mockFetch.mockReturnValue(makeFetchResponse(SAMPLE_LIMITS));

    await mod.getUsageLimits();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Manually expire the cache by advancing Date.now via spy
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 61_000);

    const updated = {
      ...SAMPLE_LIMITS,
      five_hour: { utilization: 99, resets_at: null },
    };
    mockFetch.mockReturnValue(makeFetchResponse(updated));

    const result = await mod.getUsageLimits();
    expect(result).toEqual(updated);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.spyOn(Date, "now").mockRestore();
  });

  it("returns empty when fetch fails", async () => {
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    mockFetch.mockReturnValue(makeFetchResponse({}, false));

    const result = await mod.getUsageLimits();
    expect(result).toEqual(EMPTY);
  });
});

// ===========================================================================
// Token refresh flow (via getUsageLimits → getValidAccessToken)
// ===========================================================================
describe("token refresh", () => {
  const EMPTY = { five_hour: null, seven_day: null, extra_usage: null };

  it("refreshes an expired token and uses the new one", async () => {
    // Provide an expired token
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN, { expired: true }));

    // First call = token refresh, second call = usage API
    mockFetch
      .mockReturnValueOnce(
        makeFetchResponse({
          access_token: "sk-ant-new-token",
          refresh_token: "sk-ant-new-refresh",
          expires_in: 3600,
        }),
      )
      .mockReturnValueOnce(makeFetchResponse(SAMPLE_LIMITS));

    const result = await mod.getUsageLimits();
    expect(result).toEqual(SAMPLE_LIMITS);

    // First fetch = refresh call to platform.claude.com
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [refreshUrl, refreshOpts] = mockFetch.mock.calls[0];
    expect(refreshUrl).toContain("oauth/token");
    expect(refreshOpts.method).toBe("POST");

    // Second fetch = usage API with refreshed token
    const [usageUrl, usageOpts] = mockFetch.mock.calls[1];
    expect(usageUrl).toContain("oauth/usage");
    expect(usageOpts.headers.Authorization).toBe("Bearer sk-ant-new-token");

    // Credentials should have been written back via execFileSync
    expect(mockExecFileSync).toHaveBeenCalled();
  });

  it("returns empty when token is expired and refresh fails", async () => {
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN, { expired: true }));
    // Refresh call fails
    mockFetch.mockReturnValueOnce(makeFetchResponse({}, false));

    const result = await mod.getUsageLimits();
    expect(result).toEqual(EMPTY);
    // Only the refresh call, no usage call
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns empty when token is expired and refresh throws", async () => {
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN, { expired: true }));
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const result = await mod.getUsageLimits();
    expect(result).toEqual(EMPTY);
  });

  it("uses valid (non-expired) token without refreshing", async () => {
    // Token has a future expiry (default in makeCredentialsJson)
    mockExecSync.mockReturnValue(makeCredentialsJson(SAMPLE_TOKEN));
    mockFetch.mockReturnValueOnce(makeFetchResponse(SAMPLE_LIMITS));

    const result = await mod.getUsageLimits();
    expect(result).toEqual(SAMPLE_LIMITS);
    // Only one fetch call (usage API), no refresh call
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("oauth/usage");
  });
});
