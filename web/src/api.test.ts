// @vitest-environment jsdom
import { api } from "./api.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ===========================================================================
// createSession
// ===========================================================================
describe("createSession", () => {
  it("sends POST to /api/sessions/create with body", async () => {
    const responseData = { sessionId: "s1", state: "starting", cwd: "/home" };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    const result = await api.createSession({ model: "opus", cwd: "/home" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/create");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual({ model: "opus", cwd: "/home" });
    expect(result).toEqual(responseData);
  });

  it("passes codexInternetAccess when provided", async () => {
    const responseData = { sessionId: "s2", state: "starting", cwd: "/repo" };
    mockFetch.mockResolvedValueOnce(mockResponse(responseData));

    await api.createSession({
      backend: "codex",
      cwd: "/repo",
      codexInternetAccess: true,
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({
      backend: "codex",
      cwd: "/repo",
      codexInternetAccess: true,
    });
  });
});

// ===========================================================================
// listSessions
// ===========================================================================
describe("listSessions", () => {
  it("sends GET to /api/sessions", async () => {
    const sessions = [{ sessionId: "s1", state: "connected", cwd: "/tmp" }];
    mockFetch.mockResolvedValueOnce(mockResponse(sessions));

    const result = await api.listSessions();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions");
    expect(opts).toBeUndefined();
    expect(result).toEqual(sessions);
  });
});

// ===========================================================================
// killSession
// ===========================================================================
describe("killSession", () => {
  it("sends POST with URL-encoded session ID", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.killSession("session/with/slashes");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/sessions/${encodeURIComponent("session/with/slashes")}/kill`);
    expect(opts.method).toBe("POST");
  });
});

// ===========================================================================
// deleteSession
// ===========================================================================
describe("deleteSession", () => {
  it("sends DELETE with URL-encoded session ID", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await api.deleteSession("session&id=1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/sessions/${encodeURIComponent("session&id=1")}`);
    expect(opts.method).toBe("DELETE");
  });
});

// ===========================================================================
// post() error handling
// ===========================================================================
describe("post() error handling", () => {
  it("throws with error message from JSON body on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "Session not found" }, 404));

    await expect(api.killSession("nonexistent")).rejects.toThrow("Session not found");
  });

  it("falls back to statusText when JSON body has no error field", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({}, 500));

    await expect(api.killSession("bad")).rejects.toThrow("Error");
  });
});

// ===========================================================================
// get() error handling
// ===========================================================================
describe("get() error handling", () => {
  it("throws statusText on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: () => Promise.resolve({}),
    });

    await expect(api.listSessions()).rejects.toThrow("Forbidden");
  });
});

// ===========================================================================
// listDirs
// ===========================================================================
describe("listDirs", () => {
  it("includes query param when path is provided", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ path: "/home", dirs: [], home: "/home" }));

    await api.listDirs("/home/user");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/list?path=${encodeURIComponent("/home/user")}`);
  });

  it("omits query param when path is not provided", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ path: "/", dirs: [], home: "/home" }));

    await api.listDirs();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/fs/list");
  });
});

// ===========================================================================
// createEnv
// ===========================================================================
describe("createEnv", () => {
  it("sends POST to /api/envs with name and variables", async () => {
    const envData = { name: "Prod", slug: "prod", variables: { KEY: "val" }, createdAt: 1, updatedAt: 1 };
    mockFetch.mockResolvedValueOnce(mockResponse(envData));

    const result = await api.createEnv("Prod", { KEY: "val" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/envs");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ name: "Prod", variables: { KEY: "val" } });
    expect(result).toEqual(envData);
  });
});

// ===========================================================================
// updateEnv
// ===========================================================================
describe("updateEnv", () => {
  it("sends PUT to /api/envs/:slug with data", async () => {
    const envData = { name: "Renamed", slug: "renamed", variables: {}, createdAt: 1, updatedAt: 2 };
    mockFetch.mockResolvedValueOnce(mockResponse(envData));

    await api.updateEnv("my-env", { name: "Renamed" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/envs/${encodeURIComponent("my-env")}`);
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ name: "Renamed" });
  });
});

// ===========================================================================
// getRepoInfo
// ===========================================================================
describe("getRepoInfo", () => {
  it("sends GET with encoded path query param", async () => {
    const info = { repoRoot: "/repo", repoName: "app", currentBranch: "main", defaultBranch: "main", isWorktree: false };
    mockFetch.mockResolvedValueOnce(mockResponse(info));

    const result = await api.getRepoInfo("/path/to repo");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/git/repo-info?path=${encodeURIComponent("/path/to repo")}`);
    expect(result).toEqual(info);
  });
});

// ===========================================================================
// removeWorktree
// ===========================================================================
describe("removeWorktree", () => {
  it("sends DELETE to /api/git/worktree with body", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ removed: true }));

    await api.removeWorktree("/repo", "/repo-wt", true);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/git/worktree");
    expect(opts.method).toBe("DELETE");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual({ repoRoot: "/repo", worktreePath: "/repo-wt", force: true });
  });
});

// ===========================================================================
// getFileDiff
// ===========================================================================
describe("getFileDiff", () => {
  it("sends GET with encoded path query param", async () => {
    const diffData = { path: "/repo/file.ts", diff: "+new line\n-old line" };
    mockFetch.mockResolvedValueOnce(mockResponse(diffData));

    const result = await api.getFileDiff("/repo/file.ts");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/fs/diff?path=${encodeURIComponent("/repo/file.ts")}`);
    expect(result).toEqual(diffData);
  });
});

// ===========================================================================
// getSessionUsageLimits
// ===========================================================================
describe("getSessionUsageLimits", () => {
  it("sends GET to /api/sessions/:id/usage-limits", async () => {
    const limitsData = {
      five_hour: { utilization: 25, resets_at: "2026-01-01T12:00:00Z" },
      seven_day: null,
      extra_usage: null,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(limitsData));

    const result = await api.getSessionUsageLimits("sess-123");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/sessions/sess-123/usage-limits");
    expect(result).toEqual(limitsData);
  });
});
