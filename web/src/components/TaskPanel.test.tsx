// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("../api.js", () => ({
  api: {
    getSessionUsageLimits: vi.fn().mockRejectedValue(new Error("skip")),
    getPRStatus: vi.fn().mockRejectedValue(new Error("skip")),
  },
}));

vi.mock("./McpPanel.js", () => ({
  McpSection: () => <div data-testid="mcp-section">MCP Section</div>,
}));

interface MockStoreState {
  sessionTasks: Map<string, { id: string; status: string; subject: string }[]>;
  sessions: Map<string, { backend_type?: string; cwd?: string; git_branch?: string }>;
  sdkSessions: { sessionId: string; backendType?: string; cwd?: string; gitBranch?: string }[];
  taskPanelOpen: boolean;
  setTaskPanelOpen: ReturnType<typeof vi.fn>;
  prStatus: Map<string, { available: boolean; pr?: unknown } | null>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    sessionTasks: new Map(),
    sessions: new Map([["s1", { backend_type: "codex" }]]),
    sdkSessions: [],
    taskPanelOpen: true,
    setTaskPanelOpen: vi.fn(),
    prStatus: new Map(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(mockState),
}));

import { TaskPanel } from "./TaskPanel.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("TaskPanel", () => {
  it("renders nothing when closed", () => {
    resetStore({ taskPanelOpen: false });
    const { container } = render(<TaskPanel sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("keeps a single scroll container for long MCP content even without tasks", () => {
    // Regression coverage: Codex sessions do not render the Tasks list,
    // so the panel itself must still provide vertical scrolling.
    const { container } = render(<TaskPanel sessionId="s1" />);

    expect(screen.getByTestId("mcp-section")).toBeInTheDocument();
    expect(screen.getByTestId("task-panel-content")).toHaveClass("overflow-y-auto");
    expect(container.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
  });
});
