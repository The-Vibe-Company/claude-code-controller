import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock env-manager and git-utils modules before any imports
vi.mock("./env-manager.js", () => ({
  listEnvs: vi.fn(() => []),
  getEnv: vi.fn(() => null),
  getEffectiveImage: vi.fn(() => null),
  createEnv: vi.fn(),
  updateEnv: vi.fn(),
  deleteEnv: vi.fn(),
}));

vi.mock("./prompt-manager.js", () => ({
  listPrompts: vi.fn(() => []),
  getPrompt: vi.fn(() => null),
  createPrompt: vi.fn(),
  updatePrompt: vi.fn(),
  deletePrompt: vi.fn(() => false),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
}));

const mockResolveBinary = vi.hoisted(() => vi.fn((_name: string) => null as string | null));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: mockResolveBinary,
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
  gitFetch: vi.fn(() => ({ success: true, output: "" })),
  gitPull: vi.fn(() => ({ success: true, output: "" })),
  checkoutBranch: vi.fn(),
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

vi.mock("./settings-manager.js", () => ({
  DEFAULT_OPENROUTER_MODEL: "openrouter/free",
  getSettings: vi.fn(() => ({
    openrouterApiKey: "",
    openrouterModel: "openrouter/free",
    updatedAt: 0,
  })),
  updateSettings: vi.fn((patch) => ({
    openrouterApiKey: patch.openrouterApiKey ?? "",
    openrouterModel: patch.openrouterModel ?? "openrouter/free",
    updatedAt: Date.now(),
  })),
}));

const mockGetUsageLimits = vi.hoisted(() => vi.fn());
const mockUpdateCheckerState = vi.hoisted(() => ({
  currentVersion: "0.22.1",
  latestVersion: null as string | null,
  lastChecked: 0,
  isServiceMode: false,
  checking: false,
  updateInProgress: false,
}));
const mockCheckForUpdate = vi.hoisted(() => vi.fn(async () => {}));
const mockIsUpdateAvailable = vi.hoisted(() => vi.fn(() => false));
const mockSetUpdateInProgress = vi.hoisted(() => vi.fn());

vi.mock("./usage-limits.js", () => ({
  getUsageLimits: mockGetUsageLimits,
}));

vi.mock("./update-checker.js", () => ({
  getUpdateState: vi.fn(() => ({ ...mockUpdateCheckerState })),
  checkForUpdate: mockCheckForUpdate,
  isUpdateAvailable: mockIsUpdateAvailable,
  setUpdateInProgress: mockSetUpdateInProgress,
}));

// Mock image-pull-manager — default: images are always ready
const mockImagePullIsReady = vi.hoisted(() => vi.fn(() => true));
interface MockImagePullState {
  image: string;
  status: "idle" | "pulling" | "ready" | "error";
  progress: string[];
  error?: string;
  startedAt?: number;
  completedAt?: number;
}
const mockImagePullGetState = vi.hoisted(() => vi.fn(
  (image: string): MockImagePullState => ({
    image,
    status: "ready",
    progress: [],
  })
));
const mockImagePullEnsureImage = vi.hoisted(() => vi.fn());
const mockImagePullWaitForReady = vi.hoisted(() => vi.fn(async () => true));
const mockImagePullPull = vi.hoisted(() => vi.fn());
const mockImagePullOnProgress = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock("./image-pull-manager.js", () => ({
  imagePullManager: {
    isReady: mockImagePullIsReady,
    getState: mockImagePullGetState,
    ensureImage: mockImagePullEnsureImage,
    waitForReady: mockImagePullWaitForReady,
    pull: mockImagePullPull,
    onProgress: mockImagePullOnProgress,
  },
}));

import { Hono } from "hono";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRoutes } from "./routes.js";
import * as envManager from "./env-manager.js";
import * as promptManager from "./prompt-manager.js";
import * as gitUtils from "./git-utils.js";
import * as sessionNames from "./session-names.js";
import * as settingsManager from "./settings-manager.js";
import { containerManager } from "./container-manager.js";

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
    relaunch: vi.fn(async () => ({ ok: true })),
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
    getAllSessions: vi.fn(() => []),
    getCodexRateLimits: vi.fn(() => null),
    markContainerized: vi.fn(),
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
let terminalManager: { getInfo: ReturnType<typeof vi.fn>; spawn: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateCheckerState.currentVersion = "0.22.1";
  mockUpdateCheckerState.latestVersion = null;
  mockUpdateCheckerState.lastChecked = 0;
  mockUpdateCheckerState.isServiceMode = false;
  mockUpdateCheckerState.checking = false;
  mockUpdateCheckerState.updateInProgress = false;
  launcher = createMockLauncher();
  bridge = createMockBridge();
  sessionStore = createMockStore();
  tracker = createMockTracker();
  terminalManager = { getInfo: vi.fn(() => null), spawn: vi.fn(() => ""), kill: vi.fn() };
  app = new Hono();
  app.route("/api", createRoutes(launcher, bridge, sessionStore, tracker, terminalManager as any));

  // Default no-op mocks for container workspace isolation (called during container session creation)
  vi.spyOn(containerManager, "copyWorkspaceToContainer").mockResolvedValue(undefined);
  vi.spyOn(containerManager, "reseedGitAuth").mockImplementation(() => {});

  // Default: images are always ready via pull manager
  mockImagePullIsReady.mockReturnValue(true);
  mockImagePullGetState.mockImplementation((image: string) => ({
    image,
    status: "ready" as const,
    progress: [],
  }));
  mockImagePullWaitForReady.mockResolvedValue(true);
});

describe("POST /api/terminal/kill", () => {
  it("returns 400 when terminalId is missing", async () => {
    const res = await app.request("/api/terminal/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(terminalManager.kill).not.toHaveBeenCalled();
  });

  it("kills only the requested terminal", async () => {
    const res = await app.request("/api/terminal/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ terminalId: "term-1" }),
    });

    expect(res.status).toBe(200);
    expect(terminalManager.kill).toHaveBeenCalledWith("term-1");
  });
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

  it("fetches and pulls before create when branch matches current branch", async () => {
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", branch: "main" }),
    });

    expect(res.status).toBe(200);
    expect(gitUtils.gitFetch).toHaveBeenCalledWith("/repo");
    expect(gitUtils.checkoutBranch).not.toHaveBeenCalled();
    expect(gitUtils.gitPull).toHaveBeenCalledWith("/repo");
  });

  it("fetches, checks out selected branch, then pulls before create", async () => {
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "develop",
      defaultBranch: "main",
      isWorktree: false,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", branch: "main" }),
    });

    expect(res.status).toBe(200);
    expect(gitUtils.gitFetch).toHaveBeenCalledWith("/repo");
    expect(gitUtils.checkoutBranch).toHaveBeenCalledWith("/repo", "main");
    expect(gitUtils.gitPull).toHaveBeenCalledWith("/repo");
    expect(vi.mocked(gitUtils.gitFetch).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(gitUtils.checkoutBranch).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(gitUtils.checkoutBranch).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(gitUtils.gitPull).mock.invocationCallOrder[0],
    );
  });

  it("returns 500 and does not launch when fetch fails before create", async () => {
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.gitFetch).mockReturnValueOnce({
      success: false,
      output: "network error",
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", branch: "main" }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({
      error: "git fetch failed before session create: network error",
    });
    expect(gitUtils.gitPull).not.toHaveBeenCalled();
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("proceeds with session creation when pull fails (non-fatal)", async () => {
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.gitPull).mockReturnValueOnce({
      success: false,
      output: "no tracking information",
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", branch: "main" }),
    });

    // Pull failure is non-fatal — session should still be created
    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalled();
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

  it("sets up a worktree when useWorktree and branch are specified", async () => {
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
    // ensureWorktree should be called with forceNew: true
    expect(gitUtils.ensureWorktree).toHaveBeenCalledWith("/repo", "feat-branch", {
      baseBranch: "main",
      createBranch: undefined,
      forceNew: true,
    });
    // launcher should receive the worktree path as cwd
    expect(launcher.launch).toHaveBeenCalled();
    const launchOpts = launcher.launch.mock.calls[0][0];
    expect(launchOpts.cwd).toBe("/home/.companion/worktrees/my-repo/feat-branch");
    // Worktree mapping should be tracked
    expect(tracker.addMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        repoRoot: "/repo",
        branch: "feat-branch",
        actualBranch: "feat-branch",
        worktreePath: "/home/.companion/worktrees/my-repo/feat-branch",
      }),
    );
  });

  it("returns 503 when env has Docker image but container startup fails", async () => {
    vi.mocked(envManager.getEnv).mockReturnValue({
      name: "Companion",
      slug: "companion",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "the-companion:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockReturnValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockImplementationOnce(() => {
      throw new Error("docker daemon timeout");
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "companion" }),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("Docker is required");
    expect(json.error).toContain("container startup failed");
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("returns 400 when containerized Codex session lacks auth", async () => {
    // Codex in containers needs OPENAI_API_KEY or ~/.codex/auth.json.
    // Auth check runs before image resolution so no need to mock imageExists.
    vi.mocked(envManager.getEnv).mockReturnValue({
      name: "Codex Docker",
      slug: "codex-docker",
      variables: {},
      baseImage: "the-companion:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockReturnValue("the-companion:latest");

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "codex-docker", backend: "codex" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Containerized Codex requires auth");
    expect(json.error).toContain("OPENAI_API_KEY");
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("allows containerized Codex when OPENAI_API_KEY is provided", async () => {
    vi.mocked(envManager.getEnv).mockReturnValue({
      name: "Codex Docker",
      slug: "codex-docker",
      variables: { OPENAI_API_KEY: "sk-test" },
      baseImage: "the-companion:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockReturnValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-codex",
      name: "companion-codex",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "codex-docker", backend: "codex" }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        backendType: "codex",
        containerId: "cid-codex",
        containerCwd: "/workspace",
      }),
    );
  });

  it("waits for background pull when image is not ready", async () => {
    // imagePullManager reports the image is not ready initially,
    // but waitForReady resolves to true (background pull succeeds).
    vi.mocked(envManager.getEnv).mockReturnValue({
      name: "Companion",
      slug: "companion",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "the-companion:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockReturnValue("the-companion:latest");
    mockImagePullIsReady.mockReturnValue(false);
    mockImagePullGetState.mockReturnValue({
      image: "the-companion:latest",
      status: "idle" as const,
      progress: [],
    });
    mockImagePullWaitForReady.mockResolvedValue(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-1",
      name: "companion-temp",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "companion" }),
    });

    expect(res.status).toBe(200);
    expect(mockImagePullEnsureImage).toHaveBeenCalledWith("the-companion:latest");
    expect(mockImagePullWaitForReady).toHaveBeenCalled();
    expect(launcher.launch).toHaveBeenCalled();
  });

  it("runs init script before launching CLI when env has initScript", async () => {
    // Environment with initScript and Docker image
    vi.mocked(envManager.getEnv).mockReturnValue({
      name: "WithInit",
      slug: "with-init",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "the-companion:latest",
      initScript: "bun install && pip install -r requirements.txt",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockReturnValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-init",
      name: "companion-init",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});
    const execAsyncSpy = vi.spyOn(containerManager, "execInContainerAsync")
      .mockResolvedValueOnce({ exitCode: 0, output: "installed!" });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "with-init" }),
    });

    expect(res.status).toBe(200);
    // Init script should have been executed
    expect(execAsyncSpy).toHaveBeenCalledWith(
      "cid-init",
      ["sh", "-lc", "bun install && pip install -r requirements.txt"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    // CLI should have been launched after init script
    expect(launcher.launch).toHaveBeenCalled();
  });

  it("returns 503 and cleans up container when init script fails", async () => {
    vi.mocked(envManager.getEnv).mockReturnValue({
      name: "FailInit",
      slug: "fail-init",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "the-companion:latest",
      initScript: "exit 1",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockReturnValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-fail",
      name: "companion-fail",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    const removeSpy = vi.spyOn(containerManager, "removeContainer").mockImplementation(() => {});
    vi.spyOn(containerManager, "execInContainerAsync")
      .mockResolvedValueOnce({ exitCode: 1, output: "npm ERR! missing script" });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "fail-init" }),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("Init script failed");
    // Container should be cleaned up
    expect(removeSpy).toHaveBeenCalled();
    // CLI should NOT have been launched
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
      {
        sessionId: "s1", state: "running", cwd: "/a", name: "Fix auth bug",
        gitBranch: "", gitAhead: 0, gitBehind: 0, totalLinesAdded: 0, totalLinesRemoved: 0,
      },
      {
        sessionId: "s2", state: "stopped", cwd: "/b",
        gitBranch: "", gitAhead: 0, gitBehind: 0, totalLinesAdded: 0, totalLinesRemoved: 0,
      },
    ]);
  });

  it("enriches sessions with git data from bridge state", async () => {
    const sessions = [
      { sessionId: "s1", state: "running", cwd: "/a" },
      { sessionId: "s2", state: "running", cwd: "/b" },
    ];
    launcher.listSessions.mockReturnValue(sessions);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({});
    bridge.getAllSessions.mockReturnValue([
      {
        session_id: "s1",
        git_branch: "feature/auth",
        git_ahead: 3,
        git_behind: 1,
        total_lines_added: 42,
        total_lines_removed: 7,
      },
    ]);

    const res = await app.request("/api/sessions", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    // s1 should have bridge git data
    expect(json[0]).toMatchObject({
      sessionId: "s1",
      gitBranch: "feature/auth",
      gitAhead: 3,
      gitBehind: 1,
      totalLinesAdded: 42,
      totalLinesRemoved: 7,
    });
    // s2 has no bridge data — defaults to empty/zero
    expect(json[1]).toMatchObject({
      sessionId: "s2",
      gitBranch: "",
      gitAhead: 0,
      gitBehind: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
    });
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
    launcher.relaunch.mockResolvedValue({ ok: true });

    const res = await app.request("/api/sessions/s1/relaunch", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(launcher.relaunch).toHaveBeenCalledWith("s1");
  });

  it("returns 503 with error when container is missing", async () => {
    launcher.relaunch.mockResolvedValue({
      ok: false,
      error: 'Container "companion-gone" was removed externally. Please create a new session.',
    });

    const res = await app.request("/api/sessions/s1/relaunch", { method: "POST" });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("removed externally");
  });

  it("returns 404 when session not found via relaunch", async () => {
    launcher.relaunch.mockResolvedValue({ ok: false, error: "Session not found" });

    const res = await app.request("/api/sessions/nonexistent/relaunch", { method: "POST" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("Session not found");
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("kills, removes, and closes session", async () => {
    const res = await app.request("/api/sessions/s1", { method: "DELETE" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true });
    expect(launcher.kill).toHaveBeenCalledWith("s1");
    expect(launcher.removeSession).toHaveBeenCalledWith("s1");
    expect(bridge.closeSession).toHaveBeenCalledWith("s1");
  });

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
    expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/feat", {
      force: false,
      branchToDelete: undefined,
    });
  });

  it("passes branchToDelete when actualBranch differs from branch", async () => {
    tracker.getBySession.mockReturnValue({
      sessionId: "s1",
      repoRoot: "/repo",
      branch: "feat",
      actualBranch: "feat-wt-1234",
      worktreePath: "/wt/feat",
      createdAt: 1000,
    });
    tracker.isWorktreeInUse.mockReturnValue(false);
    vi.mocked(gitUtils.isWorktreeDirty).mockReturnValue(false);
    vi.mocked(gitUtils.removeWorktree).mockReturnValue({ removed: true });

    const res = await app.request("/api/sessions/s1", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/feat", {
      force: false,
      branchToDelete: "feat-wt-1234",
    });
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
    expect(envManager.createEnv).toHaveBeenCalledWith(
      "Staging",
      { HOST: "staging.example.com" },
      {
        dockerfile: undefined,
        baseImage: undefined,
        ports: undefined,
        volumes: undefined,
      },
    );
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

describe("Saved prompts API", () => {
  it("lists prompts with cwd filter", async () => {
    // Confirms route passes cwd/scope filter through to prompt manager.
    const prompts = [
      {
        id: "p1",
        name: "Review",
        content: "Review this PR",
        scope: "global" as const,
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    vi.mocked(promptManager.listPrompts).mockReturnValue(prompts);

    const res = await app.request("/api/prompts?cwd=%2Frepo", { method: "GET" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(prompts);
    expect(promptManager.listPrompts).toHaveBeenCalledWith({ cwd: "/repo", scope: undefined });
  });

  it("creates a prompt", async () => {
    // Confirms payload mapping for prompt creation including project cwd.
    const created = {
      id: "p1",
      name: "Review",
      content: "Review this PR",
      scope: "project" as const,
      projectPath: "/repo",
      createdAt: 1,
      updatedAt: 1,
    };
    vi.mocked(promptManager.createPrompt).mockReturnValue(created);

    const res = await app.request("/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Review",
        content: "Review this PR",
        scope: "project",
        cwd: "/repo",
      }),
    });

    expect(res.status).toBe(201);
    expect(promptManager.createPrompt).toHaveBeenCalledWith(
      "Review",
      "Review this PR",
      "project",
      "/repo",
    );
  });

  it("updates a prompt", async () => {
    // Confirms update fields are forwarded verbatim.
    vi.mocked(promptManager.updatePrompt).mockReturnValue({
      id: "p1",
      name: "Updated",
      content: "Updated content",
      scope: "global",
      createdAt: 1,
      updatedAt: 2,
    });

    const res = await app.request("/api/prompts/p1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated", content: "Updated content" }),
    });
    expect(res.status).toBe(200);
    expect(promptManager.updatePrompt).toHaveBeenCalledWith("p1", {
      name: "Updated",
      content: "Updated content",
    });
  });

  it("deletes a prompt", async () => {
    // Confirms delete endpoint calls manager and returns ok shape.
    vi.mocked(promptManager.deletePrompt).mockReturnValue(true);

    const res = await app.request("/api/prompts/p1", { method: "DELETE" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(promptManager.deletePrompt).toHaveBeenCalledWith("p1");
  });
});

// ─── Image Pull Manager API ──────────────────────────────────────────────────

describe("GET /api/images/:tag/status", () => {
  it("returns the pull state for an image", async () => {
    mockImagePullGetState.mockReturnValueOnce({
      image: "the-companion:latest",
      status: "ready",
      progress: [],
    });

    const res = await app.request("/api/images/the-companion%3Alatest/status");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.image).toBe("the-companion:latest");
    expect(json.status).toBe("ready");
  });
});

describe("POST /api/images/:tag/pull", () => {
  it("triggers a pull and returns the current state", async () => {
    vi.spyOn(containerManager, "checkDocker").mockReturnValue(true);
    mockImagePullGetState.mockReturnValueOnce({
      image: "the-companion:latest",
      status: "pulling",
      progress: [],
      startedAt: Date.now(),
    });

    const res = await app.request("/api/images/the-companion%3Alatest/pull", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockImagePullPull).toHaveBeenCalledWith("the-companion:latest");
  });

  it("returns 503 when Docker is not available", async () => {
    vi.spyOn(containerManager, "checkDocker").mockReturnValue(false);

    const res = await app.request("/api/images/the-companion%3Alatest/pull", {
      method: "POST",
    });
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("Docker is not available");
  });
});

// ─── Settings ────────────────────────────────────────────────────────────────

describe("GET /api/settings", () => {
  it("returns settings status without exposing the key", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      openrouterApiKey: "or-secret",
      openrouterModel: "openrouter/free",
      updatedAt: 123,
    });

    const res = await app.request("/api/settings", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      openrouterApiKeyConfigured: true,
      openrouterModel: "openrouter/free",
    });
  });

  it("reports key as not configured when empty", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      openrouterApiKey: "",
      openrouterModel: "openai/gpt-4o-mini",
      updatedAt: 123,
    });

    const res = await app.request("/api/settings", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      openrouterApiKeyConfigured: false,
      openrouterModel: "openai/gpt-4o-mini",
    });
  });
});

describe("PUT /api/settings", () => {
  it("updates settings", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      openrouterApiKey: "new-key",
      openrouterModel: "openrouter/free",
      updatedAt: 456,
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openrouterApiKey: "new-key" }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      openrouterApiKey: "new-key",
      openrouterModel: undefined,
    });
    const json = await res.json();
    expect(json).toEqual({
      openrouterApiKeyConfigured: true,
      openrouterModel: "openrouter/free",
    });
  });

  it("trims key and falls back to default model for blank value", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      openrouterApiKey: "trimmed-key",
      openrouterModel: "openrouter/free",
      updatedAt: 789,
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openrouterApiKey: "  trimmed-key  ", openrouterModel: "   " }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      openrouterApiKey: "trimmed-key",
      openrouterModel: "openrouter/free",
    });
  });

  it("updates only model without overriding key", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      openrouterApiKey: "existing-key",
      openrouterModel: "openai/gpt-4o-mini",
      updatedAt: 999,
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openrouterModel: "openai/gpt-4o-mini" }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      openrouterApiKey: undefined,
      openrouterModel: "openai/gpt-4o-mini",
    });
  });

  it("returns 400 for non-string model", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openrouterApiKey: "new-key", openrouterModel: 123 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "openrouterModel must be a string" });
  });

  it("returns 400 for non-string key", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openrouterApiKey: 123 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "openrouterApiKey must be a string" });
  });

  it("returns 400 when no settings fields are provided", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "At least one settings field is required" });
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

// ─── Update checking ────────────────────────────────────────────────────────

describe("GET /api/update-check", () => {
  it("triggers a refresh when never checked", async () => {
    mockUpdateCheckerState.lastChecked = 0;

    const res = await app.request("/api/update-check", { method: "GET" });

    expect(res.status).toBe(200);
    expect(mockCheckForUpdate).toHaveBeenCalledOnce();
  });

  it("does not trigger a refresh when the previous check is fresh", async () => {
    mockUpdateCheckerState.lastChecked = Date.now();

    const res = await app.request("/api/update-check", { method: "GET" });

    expect(res.status).toBe(200);
    expect(mockCheckForUpdate).not.toHaveBeenCalled();
  });
});

describe("POST /api/update-check", () => {
  it("always forces a refresh", async () => {
    mockUpdateCheckerState.lastChecked = Date.now();

    const res = await app.request("/api/update-check", { method: "POST" });

    expect(res.status).toBe(200);
    expect(mockCheckForUpdate).toHaveBeenCalledOnce();
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

  it("returns home as cwd when process.cwd() is the package root", async () => {
    const origCwd = process.cwd;
    const origEnv = process.env.__COMPANION_PACKAGE_ROOT;
    try {
      process.env.__COMPANION_PACKAGE_ROOT = "/opt/companion";
      process.cwd = () => "/opt/companion";
      const res = await app.request("/api/fs/home", { method: "GET" });
      const json = await res.json();
      expect(json.cwd).toBe(json.home);
    } finally {
      process.cwd = origCwd;
      process.env.__COMPANION_PACKAGE_ROOT = origEnv;
    }
  });

  it("returns home as cwd when process.cwd() is inside the package root", async () => {
    const origCwd = process.cwd;
    const origEnv = process.env.__COMPANION_PACKAGE_ROOT;
    try {
      process.env.__COMPANION_PACKAGE_ROOT = "/opt/companion";
      process.cwd = () => "/opt/companion/node_modules/.bin";
      const res = await app.request("/api/fs/home", { method: "GET" });
      const json = await res.json();
      expect(json.cwd).toBe(json.home);
    } finally {
      process.cwd = origCwd;
      process.env.__COMPANION_PACKAGE_ROOT = origEnv;
    }
  });

  it("returns actual cwd when launched from a project directory", async () => {
    const origCwd = process.cwd;
    const origEnv = process.env.__COMPANION_PACKAGE_ROOT;
    try {
      process.env.__COMPANION_PACKAGE_ROOT = "/opt/companion";
      process.cwd = () => "/Users/testuser/my-project";
      const res = await app.request("/api/fs/home", { method: "GET" });
      const json = await res.json();
      expect(json.cwd).toBe("/Users/testuser/my-project");
    } finally {
      process.cwd = origCwd;
      process.env.__COMPANION_PACKAGE_ROOT = origEnv;
    }
  });

  it("returns home as cwd when process.cwd() equals home directory", async () => {
    const { homedir } = await import("node:os");
    const origCwd = process.cwd;
    const origEnv = process.env.__COMPANION_PACKAGE_ROOT;
    try {
      delete process.env.__COMPANION_PACKAGE_ROOT;
      process.cwd = () => homedir();
      const res = await app.request("/api/fs/home", { method: "GET" });
      const json = await res.json();
      expect(json.cwd).toBe(json.home);
    } finally {
      process.cwd = origCwd;
      process.env.__COMPANION_PACKAGE_ROOT = origEnv;
    }
  });
});

describe("GET /api/fs/diff", () => {
  it("returns 400 when path is missing", async () => {
    const res = await app.request("/api/fs/diff", { method: "GET" });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "path required" });
  });

  it("diffs against HEAD by default when no base param is provided", async () => {
    // Validates that /api/fs/diff defaults to HEAD (uncommitted changes only).
    const diffOutput = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3`;
    vi.mocked(execSync)
      .mockReturnValueOnce("/repo\n") // rev-parse --show-toplevel
      .mockReturnValueOnce("file.ts\n") // ls-files --full-name
      .mockReturnValueOnce(diffOutput); // git diff HEAD

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

  it("diffs against default branch when base=default-branch", async () => {
    // Validates that /api/fs/diff uses the repository default branch as base (origin/main here).
    const diffOutput = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3`;
    vi.mocked(execSync)
      .mockReturnValueOnce("/repo\n") // rev-parse --show-toplevel
      .mockReturnValueOnce("file.ts\n") // ls-files --full-name
      .mockReturnValueOnce("refs/remotes/origin/main\n") // symbolic-ref refs/remotes/origin/HEAD
      .mockReturnValueOnce(diffOutput); // git diff origin/main

    const res = await app.request("/api/fs/diff?path=/repo/file.ts&base=default-branch", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diff).toBe(diffOutput);
    expect(json.path).toContain("file.ts");
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining("git diff origin/main"),
      expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
    );
  });

  it("returns no-index diff for untracked files", async () => {
    // Untracked files have no base-branch diff content, so API must fallback to a full-file no-index diff.
    const untrackedDiff = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello`;

    vi.mocked(execSync)
      .mockReturnValueOnce("/repo\n") // rev-parse --show-toplevel
      .mockReturnValueOnce("new.txt\n") // ls-files --full-name
      .mockReturnValueOnce("refs/remotes/origin/main\n") // symbolic-ref refs/remotes/origin/HEAD
      .mockReturnValueOnce("") // git diff origin/main -> empty for untracked
      .mockReturnValueOnce("new.txt\n") // ls-files --others --exclude-standard
      .mockImplementationOnce(() => {
        const err = new Error("diff exits with 1 for differences") as Error & { stdout: string };
        err.stdout = untrackedDiff;
        throw err;
      }); // git diff --no-index

    const res = await app.request("/api/fs/diff?path=/repo/new.txt&base=default-branch", { method: "GET" });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.diff).toContain("new file mode");
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining("git diff --no-index -- /dev/null"),
      expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
    );
  });

  it("falls back to local default branch when origin HEAD is unavailable", async () => {
    // Ensures fallback chain works when symbolic-ref fails (e.g. no origin/HEAD): use local fallback branch.
    const diffOutput = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,3 @@
 line1
+added`;
    vi.mocked(execSync)
      .mockReturnValueOnce("/repo\n") // rev-parse --show-toplevel
      .mockReturnValueOnce("file.ts\n") // ls-files --full-name
      .mockImplementationOnce(() => {
        const err = new Error("no symbol ref") as Error & { stdout: string };
        err.stdout = "error: ref refs/remotes/origin/HEAD is not a symbolic ref";
        throw err;
      }) // symbolic-ref refs/remotes/origin/HEAD unavailable
      .mockReturnValueOnce("main\n") // branch --list fallback
      .mockReturnValueOnce(diffOutput); // git diff main

    const res = await app.request("/api/fs/diff?path=/repo/file.ts&base=default-branch", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diff).toBe(diffOutput);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining("git diff main"),
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
    // resolveBinary returns a path for both binaries
    mockResolveBinary
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

  it("marks backends as unavailable when binary is not found", async () => {
    // resolveBinary returns null for both
    mockResolveBinary
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null);

    const res = await app.request("/api/backends", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([
      { id: "claude", name: "Claude Code", available: false },
      { id: "codex", name: "Codex", available: false },
    ]);
  });

  it("handles mixed availability", async () => {
    mockResolveBinary
      .mockReturnValueOnce("/usr/bin/claude") // claude found
      .mockReturnValueOnce(null); // codex not found

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

// ─── SSE Session Creation Streaming ──────────────────────────────────────────

/** Parse an SSE response body into an array of {event, data} objects */
async function parseSSE(res: Response): Promise<{ event: string; data: string }[]> {
  const text = await res.text();
  const events: { event: string; data: string }[] = [];
  // SSE frames are separated by double newlines
  for (const block of text.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event = "message";
    let data = "";
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (data) events.push({ event, data });
  }
  return events;
}

describe("POST /api/sessions/create-stream", () => {
  it("emits progress events and done event for a basic session", async () => {
    // Simple session creation with no containers or worktrees
    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await parseSSE(res);

    // Should have resolving_env (in_progress + done) and launching_cli (in_progress + done)
    const progressEvents = events.filter((e) => e.event === "progress");
    expect(progressEvents.length).toBeGreaterThanOrEqual(4);

    // First progress should be resolving_env in_progress
    const first = JSON.parse(progressEvents[0].data);
    expect(first.step).toBe("resolving_env");
    expect(first.status).toBe("in_progress");

    // Last event should be "done" with sessionId
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    const doneData = JSON.parse(doneEvent!.data);
    expect(doneData.sessionId).toBe("session-1");
    expect(doneData.cwd).toBe("/test");
  });

  it("emits git progress events when branch is specified", async () => {
    // When branch is specified without useWorktree, should emit fetch/checkout/pull events
    vi.mocked(gitUtils.getRepoInfo).mockReturnValueOnce({
      repoRoot: "/test",
      currentBranch: "main",
      defaultBranch: "main",
    } as any);

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", branch: "feat/new" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const steps = events
      .filter((e) => e.event === "progress")
      .map((e) => JSON.parse(e.data).step);

    // Should include git operations
    expect(steps).toContain("fetching_git");
    expect(steps).toContain("checkout_branch");
    expect(steps).toContain("pulling_git");
    expect(steps).toContain("launching_cli");
  });

  it("emits worktree progress events when useWorktree is set", async () => {
    vi.mocked(gitUtils.getRepoInfo).mockReturnValueOnce({
      repoRoot: "/test",
      currentBranch: "main",
      defaultBranch: "main",
    } as any);
    vi.mocked(gitUtils.ensureWorktree).mockReturnValueOnce({
      worktreePath: "/test-wt-123",
      actualBranch: "feat/auth",
      created: true,
    } as any);

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", branch: "feat/auth", useWorktree: true }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const steps = events
      .filter((e) => e.event === "progress")
      .map((e) => JSON.parse(e.data).step);

    expect(steps).toContain("creating_worktree");
    expect(steps).toContain("launching_cli");
    // Should NOT have fetch/checkout/pull since it uses worktree
    expect(steps).not.toContain("fetching_git");
  });

  it("emits error event for invalid branch name", async () => {
    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", branch: "bad branch name!" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    const errorData = JSON.parse(errorEvent!.data);
    expect(errorData.error).toContain("Invalid branch name");

    // No done event should be emitted
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeUndefined();

    // CLI should NOT be launched
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("emits error event for invalid backend", async () => {
    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", backend: "invalid" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    expect(JSON.parse(errorEvent!.data).error).toContain("Invalid backend");
  });

  it("emits container progress events for containerized session", async () => {
    // Env with Docker image — image already exists
    vi.mocked(envManager.getEnv).mockReturnValue({
      name: "Docker",
      slug: "docker",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "the-companion:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockReturnValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-stream",
      name: "companion-stream",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "docker" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const steps = events
      .filter((e) => e.event === "progress")
      .map((e) => JSON.parse(e.data).step);

    expect(steps).toContain("creating_container");
    expect(steps).toContain("launching_cli");
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        containerId: "cid-stream",
        containerCwd: "/workspace",
      }),
    );

    // Done event should include sessionId
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    expect(JSON.parse(doneEvent!.data).sessionId).toBe("session-1");
  });

  it("emits pulling_image step when image is not ready and waits for background pull", async () => {
    // Env with Docker image that is not available yet — pull manager handles it
    vi.mocked(envManager.getEnv).mockReturnValue({
      name: "Docker",
      slug: "docker",
      variables: { ANTHROPIC_API_KEY: "key" },
      baseImage: "the-companion:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockReturnValue("the-companion:latest");
    // Image not ready initially — pull manager will handle it
    mockImagePullIsReady.mockReturnValue(false);
    mockImagePullGetState.mockReturnValue({
      image: "the-companion:latest",
      status: "idle" as const,
      progress: [],
    });
    mockImagePullWaitForReady.mockResolvedValue(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-pulled",
      name: "companion-pulled",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "docker" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const steps = events
      .filter((e) => e.event === "progress")
      .map((e) => JSON.parse(e.data).step);

    // Should have pulling_image step
    expect(steps).toContain("pulling_image");
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        containerId: "cid-pulled",
        containerCwd: "/workspace",
      }),
    );
    expect(mockImagePullEnsureImage).toHaveBeenCalledWith("the-companion:latest");
    expect(mockImagePullWaitForReady).toHaveBeenCalled();
  });

  it("returns error when background pull fails", async () => {
    vi.mocked(envManager.getEnv).mockReturnValue({
      name: "Docker",
      slug: "docker",
      variables: { ANTHROPIC_API_KEY: "key" },
      baseImage: "the-companion:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockReturnValue("the-companion:latest");
    mockImagePullIsReady.mockReturnValue(false);
    mockImagePullGetState.mockReturnValue({
      image: "the-companion:latest",
      status: "error" as const,
      progress: [],
      error: "Pull and build both failed",
    });
    mockImagePullWaitForReady.mockResolvedValue(false);

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "docker" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    expect(JSON.parse(errorEvent!.data).error).toContain("Pull and build both failed");
  });

  it("emits init script progress events when env has initScript", async () => {
    vi.mocked(envManager.getEnv).mockReturnValue({
      name: "WithInit",
      slug: "with-init",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "the-companion:latest",
      initScript: "npm install",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockReturnValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-init-stream",
      name: "companion-init-stream",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});
    vi.spyOn(containerManager, "execInContainerAsync")
      .mockResolvedValueOnce({ exitCode: 0, output: "ok" });

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "with-init" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const steps = events
      .filter((e) => e.event === "progress")
      .map((e) => JSON.parse(e.data).step);

    expect(steps).toContain("running_init_script");
    expect(steps).toContain("launching_cli");

    // Done event should be present
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
  });

  it("emits error and cleans up when init script fails", async () => {
    vi.mocked(envManager.getEnv).mockReturnValue({
      name: "FailInit",
      slug: "fail-init",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "the-companion:latest",
      initScript: "exit 1",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockReturnValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-fail-stream",
      name: "companion-fail-stream",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    const removeSpy = vi.spyOn(containerManager, "removeContainer").mockImplementation(() => {});
    vi.spyOn(containerManager, "execInContainerAsync")
      .mockResolvedValueOnce({ exitCode: 1, output: "npm ERR! missing script" });

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "fail-init" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);

    // Should have an error event for init script failure
    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    const errorData = JSON.parse(errorEvent!.data);
    expect(errorData.error).toContain("Init script failed");
    expect(errorData.step).toBe("running_init_script");

    // Container should be cleaned up
    expect(removeSpy).toHaveBeenCalled();

    // No done event
    expect(events.find((e) => e.event === "done")).toBeUndefined();

    // CLI should NOT be launched
    expect(launcher.launch).not.toHaveBeenCalled();
  });
});
