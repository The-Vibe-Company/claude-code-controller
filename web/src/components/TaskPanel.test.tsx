// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { getDefaultConfig, type TaskPanelConfig } from "./task-panel-sections.js";

vi.mock("../api.js", () => ({
  api: {
    getSessionUsageLimits: vi.fn().mockRejectedValue(new Error("skip")),
    getPRStatus: vi.fn().mockRejectedValue(new Error("skip")),
    getLinkedLinearIssue: vi.fn().mockResolvedValue({ issue: null }),
  },
}));

vi.mock("./McpPanel.js", () => ({
  McpSection: () => <div data-testid="mcp-section">MCP Section</div>,
}));

interface CodexTokenDetails {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  modelContextWindow: number;
}

interface CodexRateLimits {
  primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
}

interface MockStoreState {
  sessionTasks: Map<string, { id: string; status: string; subject: string }[]>;
  sessions: Map<string, {
    backend_type?: string;
    cwd?: string;
    git_branch?: string;
    codex_token_details?: CodexTokenDetails;
    codex_rate_limits?: CodexRateLimits;
    context_used_percent?: number;
  }>;
  sdkSessions: { sessionId: string; backendType?: string; cwd?: string; gitBranch?: string }[];
  taskPanelOpen: boolean;
  setTaskPanelOpen: ReturnType<typeof vi.fn>;
  taskPanelConfig: TaskPanelConfig;
  taskPanelConfigMode: boolean;
  setTaskPanelConfigMode: ReturnType<typeof vi.fn>;
  toggleSectionEnabled: ReturnType<typeof vi.fn>;
  moveSectionUp: ReturnType<typeof vi.fn>;
  moveSectionDown: ReturnType<typeof vi.fn>;
  resetTaskPanelConfig: ReturnType<typeof vi.fn>;
  prStatus: Map<string, { available: boolean; pr?: unknown } | null>;
  linkedLinearIssues: Map<string, unknown>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    sessionTasks: new Map(),
    sessions: new Map([["s1", { backend_type: "codex" }]]),
    sdkSessions: [],
    taskPanelOpen: true,
    setTaskPanelOpen: vi.fn(),
    taskPanelConfig: getDefaultConfig(),
    taskPanelConfigMode: false,
    setTaskPanelConfigMode: vi.fn(),
    toggleSectionEnabled: vi.fn(),
    moveSectionUp: vi.fn(),
    moveSectionDown: vi.fn(),
    resetTaskPanelConfig: vi.fn(),
    prStatus: new Map(),
    linkedLinearIssues: new Map(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(mockState),
    { getState: () => mockState },
  ),
}));

import { TaskPanel, CodexRateLimitsSection, CodexTokenDetailsSection } from "./TaskPanel.js";

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

  it("shows 'Customize panel' button in normal mode", () => {
    // Verify the settings button appears at the bottom of the panel
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByTestId("customize-panel-btn")).toBeInTheDocument();
    expect(screen.getByText("Customize panel")).toBeInTheDocument();
  });

  it("shows 'Panel Settings' header when in config mode", () => {
    // Config mode should replace the normal panel content with the config view
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("Panel Settings")).toBeInTheDocument();
    expect(screen.queryByTestId("task-panel-content")).not.toBeInTheDocument();
  });

  it("does not show tasks section for Codex sessions (backend filter)", () => {
    // The "tasks" section is claude-only — it should not appear for Codex
    resetStore({
      sessions: new Map([["s1", { backend_type: "codex" }]]),
      taskPanelConfigMode: true,
    });
    render(<TaskPanel sessionId="s1" />);
    // Tasks section config row should not exist for Codex
    expect(screen.queryByTestId("config-section-tasks")).not.toBeInTheDocument();
    // Other sections should still be present
    expect(screen.getByTestId("config-section-usage-limits")).toBeInTheDocument();
  });

  it("shows tasks section config for Claude sessions", () => {
    // "tasks" section should appear in config for Claude Code backend
    resetStore({
      sessions: new Map([["s1", { backend_type: "claude" }]]),
      taskPanelConfigMode: true,
    });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByTestId("config-section-tasks")).toBeInTheDocument();
  });

  it("hides disabled sections from the main panel content", () => {
    // When a section is disabled in config, it should not render in normal mode
    const config = getDefaultConfig();
    config.enabled["mcp-servers"] = false;
    resetStore({ taskPanelConfig: config });
    render(<TaskPanel sessionId="s1" />);
    // MCP section should be hidden since it's disabled
    expect(screen.queryByTestId("mcp-section")).not.toBeInTheDocument();
  });

  it("renders config view with Done and Reset buttons", () => {
    // Verify config mode footer buttons
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByTestId("config-done")).toBeInTheDocument();
    expect(screen.getByTestId("reset-panel-config")).toBeInTheDocument();
  });

  it("renders toggle switches for all applicable sections in config mode", () => {
    // Codex should see 5 sections (all except "tasks" which is claude-only)
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByTestId("toggle-usage-limits")).toBeInTheDocument();
    expect(screen.getByTestId("toggle-git-branch")).toBeInTheDocument();
    expect(screen.getByTestId("toggle-github-pr")).toBeInTheDocument();
    expect(screen.getByTestId("toggle-linear-issue")).toBeInTheDocument();
    expect(screen.getByTestId("toggle-mcp-servers")).toBeInTheDocument();
  });

  it("calls toggleSectionEnabled when toggle is clicked", () => {
    // Clicking a toggle should call the store action
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByTestId("toggle-git-branch"));
    expect(mockState.toggleSectionEnabled).toHaveBeenCalledWith("git-branch");
  });

  it("calls moveSectionUp when up arrow is clicked", () => {
    // Clicking the up arrow should call the store action
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByTestId("move-up-git-branch"));
    expect(mockState.moveSectionUp).toHaveBeenCalledWith("git-branch");
  });

  it("calls moveSectionDown when down arrow is clicked", () => {
    // Clicking the down arrow should call the store action
    resetStore({ taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByTestId("move-down-git-branch"));
    expect(mockState.moveSectionDown).toHaveBeenCalledWith("git-branch");
  });

  it("renders sections in the configured order", () => {
    // When config order is changed, sections should render in that order
    const config = getDefaultConfig();
    config.order = ["mcp-servers", "usage-limits", "git-branch", "github-pr", "linear-issue", "tasks"];
    resetStore({ taskPanelConfig: config, taskPanelConfigMode: true });
    render(<TaskPanel sessionId="s1" />);

    // Verify the first config row is MCP servers (since we reordered)
    const rows = screen.getAllByTestId(/^config-section-/);
    expect(rows[0]).toHaveAttribute("data-testid", "config-section-mcp-servers");
    expect(rows[1]).toHaveAttribute("data-testid", "config-section-usage-limits");
  });
});

describe("CodexRateLimitsSection", () => {
  it("renders nothing when no rate limits data", () => {
    // Session exists but has no codex_rate_limits
    resetStore({ sessions: new Map([["s1", { backend_type: "codex" }]]) });
    const { container } = render(<CodexRateLimitsSection sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when both primary and secondary are null", () => {
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        codex_rate_limits: { primary: null, secondary: null },
      }]]),
    });
    const { container } = render(<CodexRateLimitsSection sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders primary rate limit bar with percentage and window label", () => {
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        codex_rate_limits: {
          primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: Date.now() + 7_200_000 },
          secondary: null,
        },
      }]]),
    });
    render(<CodexRateLimitsSection sessionId="s1" />);
    // 300 mins = 5h
    expect(screen.getByText("5h Limit")).toBeInTheDocument();
    expect(screen.getByText("62%")).toBeInTheDocument();
  });

  it("renders both primary and secondary limits", () => {
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        codex_rate_limits: {
          primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: Date.now() + 3_600_000 },
          secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: Date.now() + 86_400_000 },
        },
      }]]),
    });
    render(<CodexRateLimitsSection sessionId="s1" />);
    // 300 mins = 5h, 10080 mins = 7d
    expect(screen.getByText("5h Limit")).toBeInTheDocument();
    expect(screen.getByText("7d Limit")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
  });
});

describe("CodexTokenDetailsSection", () => {
  it("renders nothing when no token details", () => {
    resetStore({ sessions: new Map([["s1", { backend_type: "codex" }]]) });
    const { container } = render(<CodexTokenDetailsSection sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders input and output token counts", () => {
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        context_used_percent: 42,
        codex_token_details: {
          inputTokens: 84_230,
          outputTokens: 12_450,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          modelContextWindow: 200_000,
        },
      }]]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    expect(screen.getByText("Tokens")).toBeInTheDocument();
    expect(screen.getByText("84.2k")).toBeInTheDocument();
    expect(screen.getByText("12.4k")).toBeInTheDocument();
  });

  it("shows cached and reasoning rows only when non-zero", () => {
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        context_used_percent: 55,
        codex_token_details: {
          inputTokens: 100_000,
          outputTokens: 5_000,
          cachedInputTokens: 41_200,
          reasoningOutputTokens: 8_900,
          modelContextWindow: 200_000,
        },
      }]]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    // Cached and reasoning should be visible
    expect(screen.getByText("Cached")).toBeInTheDocument();
    expect(screen.getByText("41.2k")).toBeInTheDocument();
    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.getByText("8.9k")).toBeInTheDocument();
  });

  it("hides cached and reasoning rows when zero", () => {
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        context_used_percent: 20,
        codex_token_details: {
          inputTokens: 10_000,
          outputTokens: 1_000,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          modelContextWindow: 200_000,
        },
      }]]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    expect(screen.queryByText("Cached")).not.toBeInTheDocument();
    expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
  });

  it("uses server-computed context_used_percent, not local calculation", () => {
    // Scenario: inputTokens=289500, outputTokens=2100, contextWindow=258400
    // Naive local calc would give 112%, but server caps at 100
    // This verifies the UI uses the session's context_used_percent (capped at 100)
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        context_used_percent: 100,
        codex_token_details: {
          inputTokens: 289_500,
          outputTokens: 2_100,
          cachedInputTokens: 210_300,
          reasoningOutputTokens: 741,
          modelContextWindow: 258_400,
        },
      }]]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    // Should show 100%, not 112%
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.queryByText("112%")).not.toBeInTheDocument();
  });

  it("hides context bar when modelContextWindow is 0", () => {
    resetStore({
      sessions: new Map([["s1", {
        backend_type: "codex",
        context_used_percent: 0,
        codex_token_details: {
          inputTokens: 1_000,
          outputTokens: 500,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          modelContextWindow: 0,
        },
      }]]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    expect(screen.queryByText("Context")).not.toBeInTheDocument();
  });
});

describe("TaskPanel accessibility", () => {
  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    resetStore();
    const { container } = render(<TaskPanel sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
