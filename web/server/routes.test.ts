import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock env-manager and git-utils modules before any imports
vi.mock("./env-manager.js", () => ({
  listEnvs: vi.fn(() => []),
  getEnv: vi.fn(() => null),
  createEnv: vi.fn(),
  updateEnv: vi.fn(),
  deleteEnv: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
  };
});

vi.mock("./git-utils.js", () => ({
  getRepoInfo: vi.fn(() => null),
  listBranches: vi.fn(() => []),
  listWorktrees: vi.fn(() => []),
  ensureWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  isWorktreeDirty: vi.fn(() => false),
}));

vi.mock("./session-names.js", () => ({
  getName: vi.fn(() => undefined),
  setName: vi.fn(),
  getAllNames: vi.fn(() => ({})),
  removeName: vi.fn(),
  _resetForTest: vi.fn(),
}));

const mockGetUsageLimits = vi.hoisted(() => vi.fn());
vi.mock("./usage-limits.js", () => ({
  getUsageLimits: mockGetUsageLimits,
}));

import { Hono } from "hono";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRoutes } from "./routes.js";
import * as envManager from "./env-manager.js";
import * as gitUtils from "./git-utils.js";
import * as sessionNames from "./session-names.js";

// ─── Mock factories ──────────────────────────────────────────────────────────

function createMockLauncher() {
  return {
    launch: vi.fn(() => ({
      sessionId: "session-1",
      state: "starting",
      cwd: "/test",
      createdAt: Date.now(),
    })),
    kill: vi.fn(async () => true),
    relaunch: vi.fn(async () => true),
    listSessions: vi.fn(() => []),
    getSession: vi.fn(),
    setArchived: vi.fn(),
    removeSession: vi.fn(),
  } as any;
}

function createMockBridge() {
  return {
    closeSession: vi.fn(),
    getSession: vi.fn(() => null),
    getCodexRateLimits: vi.fn(() => null),
  } as any;
}

function createMockStore() {
  return {
    setArchived: vi.fn(() => true),
  } as any;
}

function createMockTracker() {
  return {
    addMapping: vi.fn(),
    getBySession: vi.fn(() => null),
    removeBySession: vi.fn(),
    isWorktreeInUse: vi.fn(() => false),
  } as any;
}

// ─── Test setup ──────────────────────────────────────────────────────────────

let app: Hono;
let launcher: ReturnType<typeof createMockLauncher>;
let bridge: ReturnType<typeof createMockBridge>;
let sessionStore: ReturnType<typeof createMockStore>;
let tracker: ReturnType<typeof createMockTracker>;

beforeEach(() => {
  vi.clearAllMocks();
  launcher = createMockLauncher();
  bridge = createMockBridge();
  sessionStore = createMockStore();
  tracker = createMockTracker();
  app = new Hono();
  app.route("/api", createRoutes(launcher, bridge, sessionStore, tracker));
});

// ─── Sessions ────────────────────────────────────────────────────────────────

describe("POST /api/sessions/create", () => {
  it("launches a session and returns its info", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5-20250929", cwd: "/test" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ sessionId: "session-1", state: "starting", cwd: "/test" });
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-5-20250929", cwd: "/test" }),
    );
  });

  it("injects environment variables when envSlug is provided", async () => {
    vi.mocked(envManager.getEnv).mockReturnValue({
      name: "Production",
      slug: "production",
      variables: { API_KEY: "secret123", DB_HOST: "db.example.com" },
      createdAt: 1000,
      updatedAt: 1000,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "production" }),
    });

    expect(res.status).toBe(200);
    expect(envManager.getEnv).toHaveBeenCalledWith("production");
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { API_KEY: "secret123", DB_HOST: "db.example.com" },
      }),
    );
  });

  it("sets up a worktree when branch is specified", async () => {
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.ensureWorktree).mockReturnValue({
      worktreePath: "/home/.companion/worktrees/my-repo/feat-branch",
      branch: "feat-branch",
      actualBranch: "feat-branch",
      isNew: true,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", branch: "feat-branch", useWorktree: true }),
    });

    expect(res.status).toBe(200);
    expect(gitUtils.getRepoInfo).toHaveBeenCalledWith("/repo");
    expect(gitUtils.ensureWorktree).toHaveBeenCalledWith("/repo", "feat-branch", {
      baseBranch: "main",
      createBranch: undefined,
      forceNew: true,
    });
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/home/.companion/worktrees/my-repo/feat-branch",
        worktreeInfo: expect.objectContaining({
          isWorktree: true,
          repoRoot: "/repo",
          branch: "feat-branch",
          actualBranch: "feat-branch",
          worktreePath: "/home/.companion/worktrees/my-repo/feat-branch",
        }),
      }),
    );
    expect(tracker.addMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        repoRoot: "/repo",
        branch: "feat-branch",
        actualBranch: "feat-branch",
      }),
    );
  });

  it("returns 500 when launch throws an error", async () => {
    launcher.launch.mockImplementation(() => {
      throw new Error("CLI binary not found");
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test" }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: "CLI binary not found" });
  });

  it("returns 400 for invalid backend values", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", backend: "invalid-backend" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid backend");
    expect(launcher.launch).not.toHaveBeenCalled();
  });
});

describe("GET /api/sessions", () => {
  it("returns the list of sessions enriched with names", async () => {
    const sessions = [
      { sessionId: "s1", state: "running", cwd: "/a" },
      { sessionId: "s2", state: "stopped", cwd: "/b" },
    ];
    launcher.listSessions.mockReturnValue(sessions);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({ s1: "Fix auth bug" });

    const res = await app.request("/api/sessions", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([
      { sessionId: "s1", state: "running", cwd: "/a", name: "Fix auth bug" },
      { sessionId: "s2", state: "stopped", cwd: "/b" },
    ]);
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns the session when found", async () => {
    const session = { sessionId: "s1", state: "running", cwd: "/test" };
    launcher.getSession.mockReturnValue(session);

    const res = await app.request("/api/sessions/s1", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(session);
  });

  it("returns 404 when session not found", async () => {
    launcher.getSession.mockReturnValue(undefined);

    const res = await app.request("/api/sessions/nonexistent", { method: "GET" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toEqual({ error: "Session not found" });
  });
});

describe("POST /api/sessions/:id/kill", () => {
  it("returns ok when session is killed", async () => {
    launcher.kill.mockResolvedValue(true);

    const res = await app.request("/api/sessions/s1/kill", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(launcher.kill).toHaveBeenCalledWith("s1");
  });

  it("returns 404 when session not found", async () => {
    launcher.kill.mockResolvedValue(false);

    const res = await app.request("/api/sessions/nonexistent/kill", { method: "POST" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toEqual({ error: "Session not found or already exited" });
  });
});

describe("POST /api/sessions/:id/relaunch", () => {
  it("returns ok when session is relaunched", async () => {
    launcher.relaunch.mockResolvedValue(true);

    const res = await app.request("/api/sessions/s1/relaunch", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(launcher.relaunch).toHaveBeenCalledWith("s1");
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("kills, removes, cleans up worktree, and closes session", async () => {
    tracker.getBySession.mockReturnValue({
      sessionId: "s1",
      repoRoot: "/repo",
      branch: "feat",
      worktreePath: "/wt/feat",
      createdAt: 1000,
    });
    tracker.isWorktreeInUse.mockReturnValue(false);
    vi.mocked(gitUtils.isWorktreeDirty).mockReturnValue(false);
    vi.mocked(gitUtils.removeWorktree).mockReturnValue({ removed: true });

    const res = await app.request("/api/sessions/s1", { method: "DELETE" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true });
    expect(json.worktree).toMatchObject({ cleaned: true, path: "/wt/feat" });
    expect(launcher.kill).toHaveBeenCalledWith("s1");
    expect(launcher.removeSession).toHaveBeenCalledWith("s1");
    expect(bridge.closeSession).toHaveBeenCalledWith("s1");
    expect(tracker.removeBySession).toHaveBeenCalledWith("s1");
    // No branchToDelete when actualBranch is not set
    expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/feat", {
      force: false,
      branchToDelete: undefined,
    });
  });

  it("passes branchToDelete when actualBranch differs from branch", async () => {
    tracker.getBySession.mockReturnValue({
      sessionId: "s1",
      repoRoot: "/repo",
      branch: "main",
      actualBranch: "main-wt-2",
      worktreePath: "/wt/main",
      createdAt: 1000,
    });
    tracker.isWorktreeInUse.mockReturnValue(false);
    vi.mocked(gitUtils.isWorktreeDirty).mockReturnValue(false);
    vi.mocked(gitUtils.removeWorktree).mockReturnValue({ removed: true });

    const res = await app.request("/api/sessions/s1", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/main", {
      force: false,
      branchToDelete: "main-wt-2",
    });
    expect(tracker.removeBySession).toHaveBeenCalledWith("s1");
  });
});

describe("POST /api/sessions/:id/archive", () => {
  it("kills and archives the session", async () => {
    const res = await app.request("/api/sessions/s1/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true });
    expect(launcher.kill).toHaveBeenCalledWith("s1");
    expect(launcher.setArchived).toHaveBeenCalledWith("s1", true);
    expect(sessionStore.setArchived).toHaveBeenCalledWith("s1", true);
  });
});

describe("POST /api/sessions/:id/unarchive", () => {
  it("unarchives the session", async () => {
    const res = await app.request("/api/sessions/s1/unarchive", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(launcher.setArchived).toHaveBeenCalledWith("s1", false);
    expect(sessionStore.setArchived).toHaveBeenCalledWith("s1", false);
  });
});

// ─── Environments ────────────────────────────────────────────────────────────

describe("GET /api/envs", () => {
  it("returns the list of environments", async () => {
    const envs = [
      { name: "Dev", slug: "dev", variables: { A: "1" }, createdAt: 1, updatedAt: 1 },
    ];
    vi.mocked(envManager.listEnvs).mockReturnValue(envs);

    const res = await app.request("/api/envs", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(envs);
  });
});

describe("POST /api/envs", () => {
  it("creates an environment and returns 201", async () => {
    const created = {
      name: "Staging",
      slug: "staging",
      variables: { HOST: "staging.example.com" },
      createdAt: 1000,
      updatedAt: 1000,
    };
    vi.mocked(envManager.createEnv).mockReturnValue(created);

    const res = await app.request("/api/envs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Staging", variables: { HOST: "staging.example.com" } }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual(created);
    expect(envManager.createEnv).toHaveBeenCalledWith("Staging", { HOST: "staging.example.com" });
  });

  it("returns 400 when createEnv throws", async () => {
    vi.mocked(envManager.createEnv).mockImplementation(() => {
      throw new Error("Environment name is required");
    });

    const res = await app.request("/api/envs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "Environment name is required" });
  });
});

describe("PUT /api/envs/:slug", () => {
  it("updates an existing environment", async () => {
    const updated = {
      name: "Production v2",
      slug: "production-v2",
      variables: { KEY: "new-value" },
      createdAt: 1000,
      updatedAt: 2000,
    };
    vi.mocked(envManager.updateEnv).mockReturnValue(updated);

    const res = await app.request("/api/envs/production", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Production v2", variables: { KEY: "new-value" } }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(updated);
    expect(envManager.updateEnv).toHaveBeenCalledWith("production", {
      name: "Production v2",
      variables: { KEY: "new-value" },
    });
  });
});

describe("DELETE /api/envs/:slug", () => {
  it("deletes an existing environment", async () => {
    vi.mocked(envManager.deleteEnv).mockReturnValue(true);

    const res = await app.request("/api/envs/staging", { method: "DELETE" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(envManager.deleteEnv).toHaveBeenCalledWith("staging");
  });

  it("returns 404 when environment not found", async () => {
    vi.mocked(envManager.deleteEnv).mockReturnValue(false);

    const res = await app.request("/api/envs/nonexistent", { method: "DELETE" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toEqual({ error: "Environment not found" });
  });
});

// ─── Git ─────────────────────────────────────────────────────────────────────

describe("GET /api/git/repo-info", () => {
  it("returns repo info for a valid path", async () => {
    const info = {
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    };
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue(info);

    const res = await app.request("/api/git/repo-info?path=/repo", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(info);
    expect(gitUtils.getRepoInfo).toHaveBeenCalledWith("/repo");
  });

  it("returns 400 when path query parameter is missing", async () => {
    const res = await app.request("/api/git/repo-info", { method: "GET" });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "path required" });
  });
});

describe("GET /api/git/branches", () => {
  it("returns branches for a repo", async () => {
    const branches = [
      { name: "main", isCurrent: true, isRemote: false, worktreePath: null, ahead: 0, behind: 0 },
      { name: "dev", isCurrent: false, isRemote: false, worktreePath: null, ahead: 2, behind: 0 },
    ];
    vi.mocked(gitUtils.listBranches).mockReturnValue(branches);

    const res = await app.request("/api/git/branches?repoRoot=/repo", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(branches);
    expect(gitUtils.listBranches).toHaveBeenCalledWith("/repo");
  });
});

describe("POST /api/git/worktree", () => {
  it("creates a worktree", async () => {
    const result = {
      worktreePath: "/home/.companion/worktrees/repo/feat",
      branch: "feat",
      actualBranch: "feat",
      isNew: true,
    };
    vi.mocked(gitUtils.ensureWorktree).mockReturnValue(result);

    const res = await app.request("/api/git/worktree", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoRoot: "/repo", branch: "feat", baseBranch: "main" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(result);
    expect(gitUtils.ensureWorktree).toHaveBeenCalledWith("/repo", "feat", {
      baseBranch: "main",
      createBranch: undefined,
    });
  });
});

describe("DELETE /api/git/worktree", () => {
  it("removes a worktree", async () => {
    vi.mocked(gitUtils.removeWorktree).mockReturnValue({ removed: true });

    const res = await app.request("/api/git/worktree", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoRoot: "/repo", worktreePath: "/wt/feat", force: true }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ removed: true });
    expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/feat", { force: true });
  });
});

// ─── Session Naming ─────────────────────────────────────────────────────────

describe("PATCH /api/sessions/:id/name", () => {
  it("updates session name and returns ok", async () => {
    launcher.getSession.mockReturnValue({ sessionId: "s1", state: "running", cwd: "/test" });

    const res = await app.request("/api/sessions/s1/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Fix auth bug" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, name: "Fix auth bug" });
    expect(sessionNames.setName).toHaveBeenCalledWith("s1", "Fix auth bug");
  });

  it("trims whitespace from name", async () => {
    launcher.getSession.mockReturnValue({ sessionId: "s1", state: "running", cwd: "/test" });

    const res = await app.request("/api/sessions/s1/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  My Session  " }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, name: "My Session" });
    expect(sessionNames.setName).toHaveBeenCalledWith("s1", "My Session");
  });

  it("returns 404 when session not found", async () => {
    launcher.getSession.mockReturnValue(undefined);

    const res = await app.request("/api/sessions/nonexistent/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Some name" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toEqual({ error: "Session not found" });
  });

  it("returns 400 when name is empty", async () => {
    const res = await app.request("/api/sessions/s1/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "name is required" });
  });

  it("returns 400 when name is missing", async () => {
    const res = await app.request("/api/sessions/s1/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

// ─── Filesystem ──────────────────────────────────────────────────────────────

describe("GET /api/fs/home", () => {
  it("returns home directory and cwd", async () => {
    const res = await app.request("/api/fs/home", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("home");
    expect(json).toHaveProperty("cwd");
    expect(typeof json.home).toBe("string");
    expect(typeof json.cwd).toBe("string");
  });
});

describe("GET /api/fs/diff", () => {
  it("returns 400 when path is missing", async () => {
    const res = await app.request("/api/fs/diff", { method: "GET" });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "path required" });
  });

  it("returns unified diff for a file", async () => {
    const diffOutput = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3`;
    vi.mocked(execSync).mockReturnValueOnce(diffOutput);

    const res = await app.request("/api/fs/diff?path=/repo/file.ts", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diff).toBe(diffOutput);
    expect(json.path).toContain("file.ts");
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining("git diff HEAD"),
      expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
    );
  });

  it("returns empty diff when git command fails", async () => {
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw new Error("not a git repository");
    });

    const res = await app.request("/api/fs/diff?path=/not-a-repo/file.ts", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diff).toBe("");
    expect(json.path).toContain("file.ts");
  });
});

// ─── Backends ─────────────────────────────────────────────────────────────────

describe("GET /api/backends", () => {
  it("returns both backends with availability status", async () => {
    // First call: `which claude` succeeds, second: `which codex` succeeds
    vi.mocked(execSync)
      .mockReturnValueOnce("/usr/bin/claude")
      .mockReturnValueOnce("/usr/bin/codex");

    const res = await app.request("/api/backends", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([
      { id: "claude", name: "Claude Code", available: true },
      { id: "codex", name: "Codex", available: true },
    ]);
  });

  it("marks backends as unavailable when CLI is not found", async () => {
    vi.mocked(execSync)
      .mockImplementationOnce(() => { throw new Error("not found"); })
      .mockImplementationOnce(() => { throw new Error("not found"); });

    const res = await app.request("/api/backends", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([
      { id: "claude", name: "Claude Code", available: false },
      { id: "codex", name: "Codex", available: false },
    ]);
  });

  it("handles mixed availability", async () => {
    vi.mocked(execSync)
      .mockReturnValueOnce("/usr/bin/claude") // claude found
      .mockImplementationOnce(() => { throw new Error("not found"); }); // codex not found

    const res = await app.request("/api/backends", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0].available).toBe(true);
    expect(json[1].available).toBe(false);
  });
});

describe("GET /api/backends/:id/models", () => {
  it("returns codex models from cache file sorted by priority", async () => {
    const cacheContent = JSON.stringify({
      models: [
        { slug: "gpt-5.1-codex-mini", display_name: "gpt-5.1-codex-mini", description: "Fast model", visibility: "list", priority: 10 },
        { slug: "gpt-5.2-codex", display_name: "gpt-5.2-codex", description: "Frontier model", visibility: "list", priority: 0 },
        { slug: "gpt-5-codex", display_name: "gpt-5-codex", description: "Old model", visibility: "hide", priority: 8 },
      ],
    });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(cacheContent);

    const res = await app.request("/api/backends/codex/models", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    // Should only include visible models, sorted by priority
    expect(json).toEqual([
      { value: "gpt-5.2-codex", label: "gpt-5.2-codex", description: "Frontier model" },
      { value: "gpt-5.1-codex-mini", label: "gpt-5.1-codex-mini", description: "Fast model" },
    ]);
  });

  it("returns 404 when codex cache file does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const res = await app.request("/api/backends/codex/models", { method: "GET" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("Codex models cache not found");
  });

  it("returns 500 when cache file is malformed", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not valid json{{{");

    const res = await app.request("/api/backends/codex/models", { method: "GET" });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("Failed to parse");
  });

  it("returns 404 for claude backend (uses frontend defaults)", async () => {
    const res = await app.request("/api/backends/claude/models", { method: "GET" });

    expect(res.status).toBe(404);
  });
});

// ─── Session creation with backend type ──────────────────────────────────────

describe("POST /api/sessions/create with backend", () => {
  it("passes backendType codex to launcher", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.2-codex", cwd: "/test", backend: "codex" }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.2-codex", backendType: "codex" }),
    );
  });

  it("defaults to claude backend when not specified", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test" }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ backendType: "claude" }),
    );
  });
});

// ─── Per-session usage limits ─────────────────────────────────────────────────

describe("GET /api/sessions/:id/usage-limits", () => {
  it("returns Claude usage limits for a claude session", async () => {
    bridge.getSession.mockReturnValue({ backendType: "claude" });
    mockGetUsageLimits.mockResolvedValue({
      five_hour: { utilization: 42, resets_at: "2025-01-01T12:00:00Z" },
      seven_day: { utilization: 15, resets_at: null },
      extra_usage: null,
    });

    const res = await app.request("/api/sessions/s1/usage-limits", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      five_hour: { utilization: 42, resets_at: "2025-01-01T12:00:00Z" },
      seven_day: { utilization: 15, resets_at: null },
      extra_usage: null,
    });
    expect(mockGetUsageLimits).toHaveBeenCalled();
  });

  it("returns mapped Codex rate limits for a codex session", async () => {
    bridge.getSession.mockReturnValue({ backendType: "codex" });
    bridge.getCodexRateLimits.mockReturnValue({
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1730947200 },
      secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1731552000 },
    });

    const res = await app.request("/api/sessions/s1/usage-limits", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.five_hour).toEqual({
      utilization: 25,
      resets_at: new Date(1730947200 * 1000).toISOString(),
    });
    expect(json.seven_day).toEqual({
      utilization: 10,
      resets_at: new Date(1731552000 * 1000).toISOString(),
    });
    expect(json.extra_usage).toBeNull();
    expect(mockGetUsageLimits).not.toHaveBeenCalled();
  });

  it("returns empty limits when codex session has no rate limits yet", async () => {
    bridge.getSession.mockReturnValue({ backendType: "codex" });
    bridge.getCodexRateLimits.mockReturnValue(null);

    const res = await app.request("/api/sessions/s1/usage-limits", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ five_hour: null, seven_day: null, extra_usage: null });
  });

  it("handles codex rate limits with null secondary", async () => {
    bridge.getSession.mockReturnValue({ backendType: "codex" });
    bridge.getCodexRateLimits.mockReturnValue({
      primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 0 },
      secondary: null,
    });

    const res = await app.request("/api/sessions/s1/usage-limits", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.five_hour).toEqual({ utilization: 50, resets_at: null });
    expect(json.seven_day).toBeNull();
  });

  it("falls back to Claude limits when session is not found", async () => {
    bridge.getSession.mockReturnValue(null);
    mockGetUsageLimits.mockResolvedValue({
      five_hour: null,
      seven_day: null,
      extra_usage: null,
    });

    const res = await app.request("/api/sessions/unknown/usage-limits", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ five_hour: null, seven_day: null, extra_usage: null });
    expect(mockGetUsageLimits).toHaveBeenCalled();
  });
});
