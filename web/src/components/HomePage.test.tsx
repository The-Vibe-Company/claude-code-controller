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
});
