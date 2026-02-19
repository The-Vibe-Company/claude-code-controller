// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

interface MockStoreState {
  currentSessionId: string | null;
  sessions: Map<string, { cwd?: string }>;
  sdkSessions: Array<{ sessionId: string; cwd: string }>;
}

let mockState: MockStoreState;

const mockApi = {
  listPrompts: vi.fn(),
  createPrompt: vi.fn(),
  updatePrompt: vi.fn(),
  deletePrompt: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    listPrompts: (...args: unknown[]) => mockApi.listPrompts(...args),
    createPrompt: (...args: unknown[]) => mockApi.createPrompt(...args),
    updatePrompt: (...args: unknown[]) => mockApi.updatePrompt(...args),
    deletePrompt: (...args: unknown[]) => mockApi.deletePrompt(...args),
  },
}));

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

import { PromptsPage } from "./PromptsPage.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockState = {
    currentSessionId: "s1",
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
  };
  mockApi.listPrompts.mockResolvedValue([]);
  mockApi.createPrompt.mockResolvedValue({
    id: "p1",
    name: "review-pr",
    content: "Review this PR",
    scope: "project",
    projectPath: "/repo",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  mockApi.updatePrompt.mockResolvedValue({
    id: "p1",
    name: "updated",
    content: "Updated prompt content",
    scope: "project",
    projectPath: "/repo",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  mockApi.deletePrompt.mockResolvedValue({ ok: true });
});

describe("PromptsPage", () => {
  it("loads prompts on mount using current session cwd", async () => {
    // Validates global-only prompt listing is fetched with global scope.
    render(<PromptsPage embedded />);
    await waitFor(() => {
      expect(mockApi.listPrompts).toHaveBeenCalledWith("/repo", "global");
    });
  });

  it("creates a global prompt", async () => {
    // Validates create payload is forced to global scope.
    render(<PromptsPage embedded />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "review-pr" } });
    fireEvent.change(screen.getByLabelText("Content"), { target: { value: "Review this PR" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Prompt" }));

    await waitFor(() => {
      expect(mockApi.createPrompt).toHaveBeenCalledWith({
        name: "review-pr",
        content: "Review this PR",
        scope: "global",
      });
    });
  });

  it("can create a global prompt without cwd", async () => {
    // Edge case: creation should work with no active session in global-only mode.
    mockState = {
      currentSessionId: null,
      sessions: new Map(),
      sdkSessions: [],
    };
    render(<PromptsPage embedded />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "global" } });
    fireEvent.change(screen.getByLabelText("Content"), { target: { value: "Always do X" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Prompt" }));

    await waitFor(() => {
      expect(mockApi.createPrompt).toHaveBeenCalledWith({
        name: "global",
        content: "Always do X",
        scope: "global",
      });
    });
  });

  it("deletes an existing prompt", async () => {
    // Validates delete action wiring from list item to API.
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "review-pr",
        content: "Review this PR",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    render(<PromptsPage embedded />);
    await screen.findByText("review-pr");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mockApi.deletePrompt).toHaveBeenCalledWith("p1");
    });
  });

  it("edits an existing prompt", async () => {
    // Validates inline edit mode persists name and content through updatePrompt.
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "review-pr",
        content: "Review this PR",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    render(<PromptsPage embedded />);
    await screen.findByText("review-pr");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const nameInput = screen.getByDisplayValue("review-pr");
    const contentInput = screen.getByDisplayValue("Review this PR");
    fireEvent.change(nameInput, { target: { value: "review-updated" } });
    fireEvent.change(contentInput, { target: { value: "Updated content" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApi.updatePrompt).toHaveBeenCalledWith("p1", {
        name: "review-updated",
        content: "Updated content",
      });
    });
  });

  it("filters prompts by search query", async () => {
    // Validates in-page filtering over prompt name/content/scope.
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "review-pr",
        content: "Review this PR",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "p2",
        name: "write-tests",
        content: "Write missing tests",
        scope: "project",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    render(<PromptsPage embedded />);
    await screen.findByText("review-pr");

    fireEvent.change(screen.getByPlaceholderText("Search by title or content..."), {
      target: { value: "write" },
    });
    expect(screen.getByText("write-tests")).toBeInTheDocument();
    expect(screen.queryByText("review-pr")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search by title or content..."), {
      target: { value: "not-found" },
    });
    expect(screen.getByText("No prompts match your search.")).toBeInTheDocument();
  });
});
