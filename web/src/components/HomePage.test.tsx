// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const { mockApi, createSessionStreamMock, mockStoreState, mockStoreGetState } = vi.hoisted(() => ({
  mockApi: {
    getHome: vi.fn(),
    listEnvs: vi.fn(),
    getBackends: vi.fn(),
    getSettings: vi.fn(),
    discoverClaudeSessions: vi.fn(),
    listSessions: vi.fn(),
    getRepoInfo: vi.fn(),
    listBranches: vi.fn(),
    getLinearProjectMapping: vi.fn(),
    getLinearProjectIssues: vi.fn(),
    searchLinearIssues: vi.fn(),
    gitFetch: vi.fn(),
  },
  createSessionStreamMock: vi.fn(),
  mockStoreState: {
    setCurrentSession: vi.fn(),
    currentSessionId: null as string | null,
  },
  mockStoreGetState: vi.fn(() => ({})),
}));

vi.mock("../api.js", () => ({
  api: mockApi,
  createSessionStream: createSessionStreamMock,
}));

vi.mock("../store.js", () => {
  const useStore = ((selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState)) as unknown as {
    (selector: (s: typeof mockStoreState) => unknown): unknown;
    getState: () => unknown;
  };
  useStore.getState = () => mockStoreGetState();
  return { useStore };
});

vi.mock("../ws.js", () => ({
  connectSession: vi.fn(),
  waitForConnection: vi.fn().mockResolvedValue(undefined),
  sendToSession: vi.fn(),
  disconnectSession: vi.fn(),
}));

vi.mock("./EnvManager.js", () => ({ EnvManager: () => null }));
vi.mock("./FolderPicker.js", () => ({ FolderPicker: () => null }));
vi.mock("./LinearLogo.js", () => ({ LinearLogo: () => <span>Linear</span> }));

import { HomePage } from "./HomePage.js";

describe("HomePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockStoreGetState.mockReturnValue({
      clearCreation: vi.fn(),
      setSessionCreating: vi.fn(),
      addCreationProgress: vi.fn(),
      sdkSessions: [],
      setSdkSessions: vi.fn(),
      sessionNames: new Map(),
      setSessionName: vi.fn(),
      setPreviousPermissionMode: vi.fn(),
      appendMessage: vi.fn(),
      setLinkedLinearIssue: vi.fn(),
      setCreationError: vi.fn(),
    });

    mockApi.getHome.mockResolvedValue({ home: "/home/ubuntu", cwd: "/repo" });
    mockApi.listEnvs.mockResolvedValue([]);
    mockApi.getBackends.mockResolvedValue([{ id: "claude", name: "Claude", available: true }]);
    mockApi.getSettings.mockResolvedValue({ linearApiKeyConfigured: true });
    mockApi.getRepoInfo.mockResolvedValue({
      repoRoot: "/repo",
      repoName: "repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    mockApi.listBranches.mockResolvedValue([
      { name: "main", isCurrent: true, isRemote: false, worktreePath: null, ahead: 0, behind: 0 },
    ]);
    mockApi.listSessions.mockResolvedValue([]);
    mockApi.discoverClaudeSessions.mockResolvedValue({ sessions: [] });
    mockApi.getLinearProjectMapping.mockResolvedValue({
      mapping: { repoRoot: "/repo", projectId: "proj-1", projectName: "Platform", updatedAt: Date.now() },
    });
    mockApi.getLinearProjectIssues.mockResolvedValue({
      issues: [
        {
          id: "issue-1",
          identifier: "THE-147",
          title: "Associer un ticket Linear",
          description: "",
          url: "https://linear.app/the/issue/THE-147",
          branchName: "the-147-associer-un-ticket-linear",
          priorityLabel: "Medium",
          stateName: "Backlog",
          stateType: "unstarted",
          teamName: "The",
          teamKey: "THE",
          teamId: "team-1",
        },
      ],
    });
    mockApi.searchLinearIssues.mockResolvedValue({ issues: [] });
    mockApi.gitFetch.mockResolvedValue({ ok: true });
  });

  it("auto-sets branch from selected mapped Linear issue", async () => {
    // Regression guard: selecting an issue from the mapped project list must
    // update the branch picker to Linear's recommended branch.
    render(<HomePage />);

    const issueTitle = await screen.findByText(/THE-147/i);
    const issueButton = issueTitle.closest("button");
    expect(issueButton).toBeInTheDocument();
    if (!issueButton) throw new Error("Issue button not found");
    fireEvent.click(issueButton);

    await waitFor(() => {
      expect(screen.getByText("the-147-associer-un-ticket-linear")).toBeInTheDocument();
    });
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<HomePage />);
    // Wait for async effects to settle (backends, settings, etc.)
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Fix a bug, build a feature, refactor code...")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("opens a branched session immediately from row action", async () => {
    createSessionStreamMock.mockResolvedValue({
      sessionId: "session-123",
      state: "starting",
      cwd: "/repo",
    });
    mockApi.discoverClaudeSessions.mockResolvedValue({
      sessions: [
        {
          sessionId: "prior-session-123",
          cwd: "/repo",
          gitBranch: "main",
          slug: "prior-session",
          lastActivityAt: Date.now() - 60_000,
          sourceFile: "/Users/skolte/.claude/projects/-Users-skolte-repo/prior-session-123.jsonl",
        },
      ],
    });

    render(<HomePage />);

    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.click(screen.getByRole("button", { name: /branch from session/i }));
    fireEvent.click(await screen.findByRole("button", { name: /continue and open prior-session/i }));

    await waitFor(() => {
      expect(createSessionStreamMock).toHaveBeenCalled();
    });

    expect(createSessionStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeSessionAt: "prior-session-123",
        forkSession: false,
      }),
      expect.any(Function),
    );
  });

  it("detects external Claude sessions and supports row actions", async () => {
    createSessionStreamMock.mockResolvedValue({
      sessionId: "session-456",
      state: "starting",
      cwd: "/repo",
    });
    mockApi.discoverClaudeSessions.mockResolvedValue({
      sessions: [
        {
          sessionId: "ac5b80ba-2927-4f20-84c2-6bbaf9afdeb3",
          cwd: "/external-repo",
          gitBranch: "main",
          slug: "snazzy-baking-tarjan",
          lastActivityAt: 2000,
          sourceFile: "/Users/skolte/.claude/projects/-Users-skolte-Github-Private-companion/ac5b80ba-2927-4f20-84c2-6bbaf9afdeb3.jsonl",
        },
      ],
    });

    render(<HomePage />);

    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.click(screen.getByRole("button", { name: /branch from session/i }));
    fireEvent.click(await screen.findByRole("button", { name: /fork and open snazzy-baking-tarjan/i }));

    await waitFor(() => {
      expect(createSessionStreamMock).toHaveBeenCalled();
    });

    expect(createSessionStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/external-repo",
        resumeSessionAt: "ac5b80ba-2927-4f20-84c2-6bbaf9afdeb3",
        forkSession: true,
      }),
      expect.any(Function),
    );
  });

  it("shows recent sessions by default and can load older sessions", async () => {
    const now = Date.now();
    const olderSessions = Array.from({ length: 15 }, (_, index) => ({
      sessionId: `old-${index}`,
      cwd: `/repo-old-${index}`,
      gitBranch: "main",
      slug: `old-${index}`,
      lastActivityAt: now - (20 * 24 * 60 * 60 * 1000) - index * 1_000,
      sourceFile: `/Users/skolte/.claude/projects/-Users-skolte-old/old-${index}.jsonl`,
    }));
    mockApi.discoverClaudeSessions.mockResolvedValue({
      sessions: [
        {
          sessionId: "recent-1",
          cwd: "/repo",
          gitBranch: "main",
          slug: "recent-1",
          lastActivityAt: now - 60_000,
          sourceFile: "/Users/skolte/.claude/projects/-Users-skolte-repo/recent-1.jsonl",
        },
        ...olderSessions,
      ],
    });

    render(<HomePage />);

    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.click(screen.getByRole("button", { name: /branch from session/i }));

    await screen.findByText(/showing 1 of 1 recent claude session/i);
    const includeOlder = screen.getByRole("button", { name: /include older \(15\)/i });
    fireEvent.click(includeOlder);

    await screen.findByText(/showing 12 of 16 detected claude sessions/i);
    const loadMore = screen.getByRole("button", { name: /load more \(4 remaining\)/i });
    fireEvent.click(loadMore);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /fork and open old-14/i })).toBeInTheDocument();
  });

  it("filters session table with search", async () => {
    const now = Date.now();
    mockApi.discoverClaudeSessions.mockResolvedValue({
      sessions: [
        {
          sessionId: "one",
          cwd: "/repo-a",
          gitBranch: "main",
          slug: "alpha",
          lastActivityAt: now - 30_000,
          sourceFile: "/Users/skolte/.claude/projects/a/one.jsonl",
        },
        {
          sessionId: "two",
          cwd: "/repo-b",
          gitBranch: "feature/auth",
          slug: "beta",
          lastActivityAt: now - 40_000,
          sourceFile: "/Users/skolte/.claude/projects/b/two.jsonl",
        },
      ],
    });

    render(<HomePage />);
    await screen.findByPlaceholderText("Fix a bug, build a feature, refactor code...");
    fireEvent.click(screen.getByRole("button", { name: /branch from session/i }));

    const search = await screen.findByPlaceholderText("Search sessions, branch, folder, or ID");
    fireEvent.change(search, { target: { value: "auth" } });

    await screen.findByText(/showing 1 of 1 matching claude session/i);
    expect(screen.getByRole("button", { name: /fork and open beta/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /fork and open alpha/i })).not.toBeInTheDocument();
  });
});
