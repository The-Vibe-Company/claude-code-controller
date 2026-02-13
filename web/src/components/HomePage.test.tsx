// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

const mockApi = {
  getHome: vi.fn().mockResolvedValue({ home: "/home/test", cwd: "/home/test/project" }),
  listEnvs: vi.fn().mockResolvedValue([]),
  getBackends: vi.fn().mockResolvedValue([
    { id: "claude", name: "Claude Code", available: true },
    { id: "codex", name: "Codex", available: true },
  ]),
  getBackendModels: vi.fn().mockResolvedValue([
    { value: "gpt-5.3-codex", label: "gpt-5.3-codex", description: "Primary" },
  ]),
  refreshBackendModels: vi.fn().mockResolvedValue([
    { value: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark", description: "Fast" },
  ]),
  getRepoInfo: vi.fn().mockRejectedValue(new Error("not a git repo")),
  listBranches: vi.fn().mockResolvedValue([]),
};

vi.mock("../api.js", () => ({
  api: {
    getHome: (...args: unknown[]) => mockApi.getHome(...args),
    listEnvs: (...args: unknown[]) => mockApi.listEnvs(...args),
    getBackends: (...args: unknown[]) => mockApi.getBackends(...args),
    getBackendModels: (...args: unknown[]) => mockApi.getBackendModels(...args),
    refreshBackendModels: (...args: unknown[]) => mockApi.refreshBackendModels(...args),
    getRepoInfo: (...args: unknown[]) => mockApi.getRepoInfo(...args),
    listBranches: (...args: unknown[]) => mockApi.listBranches(...args),
  },
}));

vi.mock("../ws.js", () => ({
  connectSession: vi.fn(),
  waitForConnection: vi.fn(),
  sendToSession: vi.fn(),
  disconnectSession: vi.fn(),
}));

const mockStoreState = {
  setCurrentSession: vi.fn(),
  currentSessionId: null as string | null,
  sessionNames: new Map<string, string>(),
  setSessionName: vi.fn(),
  setPreviousPermissionMode: vi.fn(),
  appendMessage: vi.fn(),
};

vi.mock("../store.js", () => {
  const useStore = (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState);
  useStore.getState = () => mockStoreState;
  return { useStore };
});

vi.mock("./EnvManager.js", () => ({
  EnvManager: () => <div data-testid="env-manager" />,
}));

vi.mock("./FolderPicker.js", () => ({
  FolderPicker: () => <div data-testid="folder-picker" />,
}));

import { HomePage } from "./HomePage.js";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem("cc-backend", "codex");
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: true,
      media: "",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe("HomePage model refresh", () => {
  it("shows refresh button for codex backend and calls refresh endpoint", async () => {
    // Validates the Codex-only control is rendered and wired to backend refresh.
    const user = userEvent.setup();
    render(<HomePage />);

    const refreshButton = await screen.findByTitle("Refresh model list from Codex");
    expect(refreshButton).toBeInTheDocument();

    await user.click(refreshButton);

    await waitFor(() => {
      expect(mockApi.refreshBackendModels).toHaveBeenCalledWith("codex");
    });
  });

  it("shows loading state while refresh is in progress", async () => {
    // Keeps the request pending to verify spinner/label state while refresh is running.
    let resolveRefresh:
      | ((value: Array<{ value: string; label: string; description: string }>) => void)
      | undefined;
    mockApi.refreshBackendModels.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    const user = userEvent.setup();
    render(<HomePage />);

    const refreshButton = await screen.findByTitle("Refresh model list from Codex");
    await user.click(refreshButton);

    expect(screen.getByText("Refreshing...")).toBeInTheDocument();

    if (!resolveRefresh) {
      throw new Error("refresh promise resolver was not initialized");
    }
    resolveRefresh([{ value: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark", description: "Fast" }]);

    await waitFor(() => {
      expect(screen.getByText("Refresh models")).toBeInTheDocument();
    });
  });
});
