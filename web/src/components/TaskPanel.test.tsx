// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
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
  pluginInsights: Map<string, { id: string; plugin_id: string; title: string; message: string; level: "info" | "success" | "warning" | "error"; timestamp: number }[]>;
  plugins: Array<{ id: string; name: string }>;
  taskbarPluginFocus: string | null;
  setTaskbarPluginFocus: ReturnType<typeof vi.fn>;
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
    pluginInsights: new Map(),
    plugins: [],
    taskbarPluginFocus: null,
    setTaskbarPluginFocus: vi.fn(),
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

  it("filters automation insights by focused taskbar plugin", () => {
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      pluginInsights: new Map([
        ["s1", [
          { id: "i1", title: "N1", message: "From notifications", level: "info", timestamp: 1, plugin_id: "notifications" },
          { id: "i2", title: "P1", message: "From permission", level: "info", timestamp: 2, plugin_id: "permission-automation" },
        ]],
      ]),
      plugins: [
        { id: "notifications", name: "Notifications" },
        { id: "permission-automation", name: "Permission automation" },
      ],
      taskbarPluginFocus: "notifications",
    });

    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("From notifications")).toBeInTheDocument();
    expect(screen.queryByText("From permission")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("clears plugin focus when closing the panel", () => {
    resetStore({
      taskbarPluginFocus: "notifications",
    });

    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Close session panel" }));

    expect(mockState.setTaskPanelOpen).toHaveBeenCalledWith(false);
    expect(mockState.setTaskbarPluginFocus).toHaveBeenCalledWith(null);
  });
});
