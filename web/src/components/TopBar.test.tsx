// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("../api.js", () => ({
  api: {
    relaunchSession: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

interface MockStoreState {
  currentSessionId: string | null;
  cliConnected: Map<string, boolean>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;
  sidebarOpen: boolean;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  taskPanelOpen: boolean;
  setTaskPanelOpen: ReturnType<typeof vi.fn>;
  activeTab: "chat" | "diff";
  setActiveTab: ReturnType<typeof vi.fn>;
  quickTerminalOpen: boolean;
  quickTerminalTabs: { id: string; label: string; cwd: string; containerId?: string }[];
  openQuickTerminal: ReturnType<typeof vi.fn>;
  setQuickTerminalOpen: ReturnType<typeof vi.fn>;
  resetQuickTerminal: ReturnType<typeof vi.fn>;
  sessions: Map<string, { cwd?: string; is_containerized?: boolean }>;
  sdkSessions: { sessionId: string; cwd?: string; containerId?: string }[];
  changedFiles: Map<string, Set<string>>;
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    currentSessionId: "s1",
    cliConnected: new Map([["s1", true]]),
    sessionStatus: new Map([["s1", "idle"]]),
    sidebarOpen: true,
    setSidebarOpen: vi.fn(),
    taskPanelOpen: false,
    setTaskPanelOpen: vi.fn(),
    activeTab: "chat",
    setActiveTab: vi.fn(),
    quickTerminalOpen: false,
    quickTerminalTabs: [],
    openQuickTerminal: vi.fn(),
    setQuickTerminalOpen: vi.fn(),
    resetQuickTerminal: vi.fn(),
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
    changedFiles: new Map(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(storeState),
}));

import { TopBar } from "./TopBar.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  window.localStorage.clear();
});

describe("TopBar", () => {
  it("shows diff badge count only for files within cwd", () => {
    resetStore({
      changedFiles: new Map([
        [
          "s1",
          new Set(["/repo/src/a.ts", "/repo/src/b.ts", "/Users/stan/.claude/plans/plan.md"]),
        ],
      ]),
    });

    render(<TopBar />);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("3")).not.toBeInTheDocument();
  });

  it("hides diff badge when all changed files are out of scope", () => {
    resetStore({
      changedFiles: new Map([["s1", new Set(["/Users/stan/.claude/plans/plan.md"])]]),
    });

    render(<TopBar />);
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("opens quick terminal on click (not on hover)", () => {
    render(<TopBar />);

    const btn = screen.getByRole("button", { name: "Terminal" });
    fireEvent.mouseOver(btn);
    expect(storeState.openQuickTerminal).not.toHaveBeenCalled();

    fireEvent.click(btn);
    expect(storeState.openQuickTerminal).toHaveBeenCalledWith({ target: "host", cwd: "/repo", reuseIfExists: true });
  });

  it("opens docker quick terminal in containerized sessions", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", cwd: "/repo", containerId: "ctr-1" }],
    });
    render(<TopBar />);

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(storeState.openQuickTerminal).toHaveBeenCalledWith({
      target: "docker",
      cwd: "/workspace",
      containerId: "ctr-1",
      reuseIfExists: true,
    });
  });

  it("toggles quick terminal closed when already open with tabs", () => {
    resetStore({
      quickTerminalOpen: true,
      quickTerminalTabs: [{ id: "t1", label: "Terminal", cwd: "/repo" }],
    });
    render(<TopBar />);

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(storeState.setQuickTerminalOpen).toHaveBeenCalledWith(false);
    expect(storeState.openQuickTerminal).not.toHaveBeenCalled();
  });
});
