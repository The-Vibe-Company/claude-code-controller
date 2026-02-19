// @vitest-environment jsdom

// vi.hoisted runs before any imports, ensuring browser globals are available when store.ts initializes.
vi.hoisted(() => {
  // jsdom does not implement matchMedia
  Object.defineProperty(globalThis.window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  // Node.js 22+ native localStorage may be broken (invalid --localstorage-file).
  // Polyfill before store.ts import triggers getInitialSessionId().
  if (
    typeof globalThis.localStorage === "undefined" ||
    typeof globalThis.localStorage.getItem !== "function"
  ) {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, String(value)); },
        removeItem: (key: string) => { store.delete(key); },
        clear: () => { store.clear(); },
        get length() { return store.size; },
        key: (index: number) => [...store.keys()][index] ?? null,
      },
      writable: true,
      configurable: true,
    });
  }
});

import { useStore } from "./store.js";
import type { SessionState, PermissionRequest, ChatMessage, TaskItem, SdkSessionInfo } from "./types.js";

function makeSession(id: string): SessionState {
  return {
    session_id: id,
    model: "claude-sonnet-4-6",
    cwd: "/test",
    tools: [],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makePermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    request_id: crypto.randomUUID(),
    tool_name: "Bash",
    input: { command: "ls" },
    timestamp: Date.now(),
    tool_use_id: crypto.randomUUID(),
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: crypto.randomUUID(),
    subject: "Do something",
    description: "A task",
    status: "pending",
    ...overrides,
  };
}

beforeEach(() => {
  useStore.getState().reset();
  localStorage.clear();
});

// ─── Session management ─────────────────────────────────────────────────────

describe("Session management", () => {
  it("addSession: adds to sessions map and initializes empty messages", () => {
    const session = makeSession("s1");
    useStore.getState().addSession(session);

    const state = useStore.getState();
    expect(state.sessions.get("s1")).toEqual(session);
    expect(state.messages.get("s1")).toEqual([]);
  });

  it("addSession: does not overwrite existing messages", () => {
    const session = makeSession("s1");
    const msg = makeMessage({ role: "user", content: "existing" });
    useStore.getState().addSession(session);
    useStore.getState().appendMessage("s1", msg);

    // Re-add the same session
    useStore.getState().addSession(session);
    const state = useStore.getState();
    expect(state.messages.get("s1")).toHaveLength(1);
    expect(state.messages.get("s1")![0].content).toBe("existing");
  });

  it("updateSession: merges partial updates into existing session", () => {
    const session = makeSession("s1");
    useStore.getState().addSession(session);
    useStore.getState().updateSession("s1", { model: "claude-opus-4-6", num_turns: 5 });

    const updated = useStore.getState().sessions.get("s1")!;
    expect(updated.model).toBe("claude-opus-4-6");
    expect(updated.num_turns).toBe(5);
    // Other fields remain untouched
    expect(updated.cwd).toBe("/test");
    expect(updated.session_id).toBe("s1");
  });

  it("updateSession: no-op for unknown session", () => {
    const before = new Map(useStore.getState().sessions);
    useStore.getState().updateSession("nonexistent", { model: "claude-opus-4-6" });
    const after = useStore.getState().sessions;
    expect(after.size).toBe(before.size);
  });

  it("removeSession: cleans all maps and clears currentSessionId if removed was current", () => {
    const session = makeSession("s1");
    useStore.getState().addSession(session);
    useStore.getState().setCurrentSession("s1");
    useStore.getState().appendMessage("s1", makeMessage());
    useStore.getState().setStreaming("s1", "partial text");
    useStore.getState().setStreamingStats("s1", { startedAt: 100, outputTokens: 50 });
    useStore.getState().addPermission("s1", makePermission());
    useStore.getState().addTask("s1", makeTask());
    useStore.getState().setSessionName("s1", "My Session");
    useStore.getState().setConnectionStatus("s1", "connected");
    useStore.getState().setCliConnected("s1", true);
    useStore.getState().setSessionStatus("s1", "running");
    useStore.getState().setPreviousPermissionMode("s1", "default");

    useStore.getState().removeSession("s1");
    const state = useStore.getState();

    expect(state.sessions.has("s1")).toBe(false);
    expect(state.messages.has("s1")).toBe(false);
    expect(state.streaming.has("s1")).toBe(false);
    expect(state.streamingStartedAt.has("s1")).toBe(false);
    expect(state.streamingOutputTokens.has("s1")).toBe(false);
    expect(state.pendingPermissions.has("s1")).toBe(false);
    expect(state.sessionTasks.has("s1")).toBe(false);
    expect(state.sessionNames.has("s1")).toBe(false);
    expect(state.connectionStatus.has("s1")).toBe(false);
    expect(state.cliConnected.has("s1")).toBe(false);
    expect(state.sessionStatus.has("s1")).toBe(false);
    expect(state.previousPermissionMode.has("s1")).toBe(false);
    expect(state.currentSessionId).toBeNull();
  });

  it("removeSession: filters sdkSessions by sessionId", () => {
    const sdk1: SdkSessionInfo = {
      sessionId: "s1",
      state: "connected",
      cwd: "/test",
      createdAt: Date.now(),
    };
    const sdk2: SdkSessionInfo = {
      sessionId: "s2",
      state: "running",
      cwd: "/other",
      createdAt: Date.now(),
    };
    useStore.getState().setSdkSessions([sdk1, sdk2]);
    useStore.getState().addSession(makeSession("s1"));

    useStore.getState().removeSession("s1");
    const state = useStore.getState();
    expect(state.sdkSessions).toHaveLength(1);
    expect(state.sdkSessions[0].sessionId).toBe("s2");
  });

  it("removeSession: does not clear currentSessionId if a different session is removed", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().addSession(makeSession("s2"));
    useStore.getState().setCurrentSession("s1");

    useStore.getState().removeSession("s2");
    expect(useStore.getState().currentSessionId).toBe("s1");
  });

  it("setCurrentSession: persists to localStorage", () => {
    useStore.getState().setCurrentSession("s1");
    expect(useStore.getState().currentSessionId).toBe("s1");
    expect(localStorage.getItem("cc-current-session")).toBe("s1");
  });

  it("setCurrentSession(null): removes from localStorage", () => {
    useStore.getState().setCurrentSession("s1");
    useStore.getState().setCurrentSession(null);
    expect(useStore.getState().currentSessionId).toBeNull();
    expect(localStorage.getItem("cc-current-session")).toBeNull();
  });
});

// ─── Messages ───────────────────────────────────────────────────────────────

describe("Messages", () => {
  it("appendMessage: adds to session's list", () => {
    useStore.getState().addSession(makeSession("s1"));
    const msg = makeMessage({ content: "first" });
    useStore.getState().appendMessage("s1", msg);

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("first");
  });

  it("appendMessage: creates list even if session was not pre-initialized", () => {
    const msg = makeMessage({ content: "orphan" });
    useStore.getState().appendMessage("s1", msg);
    expect(useStore.getState().messages.get("s1")).toHaveLength(1);
  });

  it("appendMessage: deduplicates by ID", () => {
    useStore.getState().addSession(makeSession("s1"));
    const msg = makeMessage({ id: "dup-1", content: "first" });
    useStore.getState().appendMessage("s1", msg);
    useStore.getState().appendMessage("s1", { ...msg, content: "duplicate" });

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("first");
  });

  it("appendMessage: allows messages without IDs (no dedup)", () => {
    useStore.getState().addSession(makeSession("s1"));
    const msg1 = makeMessage({ id: "", content: "a" });
    const msg2 = makeMessage({ id: "", content: "b" });
    useStore.getState().appendMessage("s1", msg1);
    useStore.getState().appendMessage("s1", msg2);

    expect(useStore.getState().messages.get("s1")).toHaveLength(2);
  });

  it("setMessages: replaces all messages for a session", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().appendMessage("s1", makeMessage({ content: "old" }));

    const newMessages = [
      makeMessage({ content: "new1" }),
      makeMessage({ content: "new2" }),
    ];
    useStore.getState().setMessages("s1", newMessages);

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("new1");
    expect(messages[1].content).toBe("new2");
  });

  it("updateLastAssistantMessage: updates the last assistant message", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().appendMessage("s1", makeMessage({ role: "user", content: "q" }));
    useStore.getState().appendMessage("s1", makeMessage({ role: "assistant", content: "a1" }));
    useStore.getState().appendMessage("s1", makeMessage({ role: "assistant", content: "a2" }));

    useStore.getState().updateLastAssistantMessage("s1", (msg) => ({
      ...msg,
      content: "a2-updated",
    }));

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages[1].content).toBe("a1"); // first assistant unchanged
    expect(messages[2].content).toBe("a2-updated"); // last assistant updated
  });

  it("updateLastAssistantMessage: skips non-assistant messages from end", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().appendMessage("s1", makeMessage({ role: "assistant", content: "answer" }));
    useStore.getState().appendMessage("s1", makeMessage({ role: "user", content: "followup" }));

    useStore.getState().updateLastAssistantMessage("s1", (msg) => ({
      ...msg,
      content: "answer-updated",
    }));

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages[0].content).toBe("answer-updated");
    expect(messages[1].content).toBe("followup");
  });
});

// ─── Streaming ──────────────────────────────────────────────────────────────

describe("Streaming", () => {
  it("setStreaming: sets text for a session", () => {
    useStore.getState().setStreaming("s1", "partial output");
    expect(useStore.getState().streaming.get("s1")).toBe("partial output");
  });

  it("setStreaming(null): deletes entry", () => {
    useStore.getState().setStreaming("s1", "some text");
    useStore.getState().setStreaming("s1", null);
    expect(useStore.getState().streaming.has("s1")).toBe(false);
  });

  it("setStreamingStats: sets startedAt and outputTokens", () => {
    useStore.getState().setStreamingStats("s1", { startedAt: 12345, outputTokens: 42 });
    expect(useStore.getState().streamingStartedAt.get("s1")).toBe(12345);
    expect(useStore.getState().streamingOutputTokens.get("s1")).toBe(42);
  });

  it("setStreamingStats: sets only provided fields", () => {
    useStore.getState().setStreamingStats("s1", { startedAt: 100 });
    expect(useStore.getState().streamingStartedAt.get("s1")).toBe(100);
    expect(useStore.getState().streamingOutputTokens.has("s1")).toBe(false);
  });

  it("setStreamingStats(null): clears both fields", () => {
    useStore.getState().setStreamingStats("s1", { startedAt: 100, outputTokens: 50 });
    useStore.getState().setStreamingStats("s1", null);
    expect(useStore.getState().streamingStartedAt.has("s1")).toBe(false);
    expect(useStore.getState().streamingOutputTokens.has("s1")).toBe(false);
  });
});

// ─── Permissions ────────────────────────────────────────────────────────────

describe("Permissions", () => {
  it("addPermission: adds to nested map", () => {
    const perm = makePermission({ request_id: "r1", tool_name: "Bash" });
    useStore.getState().addPermission("s1", perm);

    const sessionPerms = useStore.getState().pendingPermissions.get("s1")!;
    expect(sessionPerms.get("r1")).toEqual(perm);
  });

  it("addPermission: accumulates multiple permissions", () => {
    const perm1 = makePermission({ request_id: "r1" });
    const perm2 = makePermission({ request_id: "r2" });
    useStore.getState().addPermission("s1", perm1);
    useStore.getState().addPermission("s1", perm2);

    const sessionPerms = useStore.getState().pendingPermissions.get("s1")!;
    expect(sessionPerms.size).toBe(2);
  });

  it("removePermission: removes specific request", () => {
    const perm1 = makePermission({ request_id: "r1" });
    const perm2 = makePermission({ request_id: "r2" });
    useStore.getState().addPermission("s1", perm1);
    useStore.getState().addPermission("s1", perm2);

    useStore.getState().removePermission("s1", "r1");

    const sessionPerms = useStore.getState().pendingPermissions.get("s1")!;
    expect(sessionPerms.has("r1")).toBe(false);
    expect(sessionPerms.has("r2")).toBe(true);
  });
});

// ─── Tasks ──────────────────────────────────────────────────────────────────

describe("Tasks", () => {
  it("addTask: appends task to session list", () => {
    const task = makeTask({ id: "t1", subject: "Fix bug" });
    useStore.getState().addTask("s1", task);

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe("Fix bug");
  });

  it("setTasks: replaces all tasks for a session", () => {
    useStore.getState().addTask("s1", makeTask({ subject: "old" }));
    const newTasks = [
      makeTask({ subject: "new1" }),
      makeTask({ subject: "new2" }),
    ];
    useStore.getState().setTasks("s1", newTasks);

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks).toHaveLength(2);
    expect(tasks[0].subject).toBe("new1");
    expect(tasks[1].subject).toBe("new2");
  });

  it("updateTask: merges updates into matching task without affecting others", () => {
    const task1 = makeTask({ id: "t1", subject: "Task 1", status: "pending" });
    const task2 = makeTask({ id: "t2", subject: "Task 2", status: "pending" });
    useStore.getState().addTask("s1", task1);
    useStore.getState().addTask("s1", task2);

    useStore.getState().updateTask("s1", "t1", { status: "completed" });

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks[0].status).toBe("completed");
    expect(tasks[0].subject).toBe("Task 1"); // other fields preserved
    expect(tasks[1].status).toBe("pending"); // other task untouched
  });
});

// ─── Session names ──────────────────────────────────────────────────────────

describe("Session names", () => {
  it("setSessionName: persists to localStorage as JSON", () => {
    useStore.getState().setSessionName("s1", "My Session");

    expect(useStore.getState().sessionNames.get("s1")).toBe("My Session");

    const stored = JSON.parse(localStorage.getItem("cc-session-names") || "[]");
    expect(stored).toEqual([["s1", "My Session"]]);
  });

  it("setSessionName: updates existing name", () => {
    useStore.getState().setSessionName("s1", "First");
    useStore.getState().setSessionName("s1", "Second");

    expect(useStore.getState().sessionNames.get("s1")).toBe("Second");

    const stored = JSON.parse(localStorage.getItem("cc-session-names") || "[]");
    const map = new Map(stored);
    expect(map.get("s1")).toBe("Second");
  });
});

// ─── Recently renamed (animation tracking) ──────────────────────────────────

describe("recentlyRenamed", () => {
  it("markRecentlyRenamed: adds session to the set", () => {
    useStore.getState().markRecentlyRenamed("s1");
    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(true);
  });

  it("clearRecentlyRenamed: removes session from the set", () => {
    useStore.getState().markRecentlyRenamed("s1");
    useStore.getState().clearRecentlyRenamed("s1");
    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(false);
  });

  it("removeSession: also clears recentlyRenamed", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().markRecentlyRenamed("s1");
    useStore.getState().removeSession("s1");
    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(false);
  });
});

// ─── UI state ───────────────────────────────────────────────────────────────

describe("UI state", () => {
  it("toggleDarkMode: flips the value and persists to localStorage", () => {
    const initial = useStore.getState().darkMode;
    useStore.getState().toggleDarkMode();

    expect(useStore.getState().darkMode).toBe(!initial);
    expect(localStorage.getItem("cc-dark-mode")).toBe(String(!initial));

    useStore.getState().toggleDarkMode();
    expect(useStore.getState().darkMode).toBe(initial);
    expect(localStorage.getItem("cc-dark-mode")).toBe(String(initial));
  });

  it("newSession: clears currentSessionId and increments homeResetKey", () => {
    useStore.getState().setCurrentSession("s1");
    const keyBefore = useStore.getState().homeResetKey;

    useStore.getState().newSession();

    expect(useStore.getState().currentSessionId).toBeNull();
    expect(useStore.getState().homeResetKey).toBe(keyBefore + 1);
    expect(localStorage.getItem("cc-current-session")).toBeNull();
  });

  it("openQuickTerminal with reuseIfExists focuses existing tab instead of creating a new one", () => {
    useStore.getState().openQuickTerminal({ target: "host", cwd: "/repo" });
    const firstTabId = useStore.getState().activeQuickTerminalTabId;

    useStore.getState().openQuickTerminal({ target: "host", cwd: "/repo", reuseIfExists: true });
    const state = useStore.getState();
    expect(state.quickTerminalTabs).toHaveLength(1);
    expect(state.activeQuickTerminalTabId).toBe(firstTabId);
  });

  it("openQuickTerminal host labels stay monotonic after closing tabs", () => {
    const store = useStore.getState();
    store.openQuickTerminal({ target: "host", cwd: "/repo/a" });
    store.openQuickTerminal({ target: "host", cwd: "/repo/b" });
    store.openQuickTerminal({ target: "host", cwd: "/repo/c" });
    const secondId = useStore.getState().quickTerminalTabs[1]?.id;
    if (secondId) store.closeQuickTerminalTab(secondId);
    store.openQuickTerminal({ target: "host", cwd: "/repo/d" });

    const labels = useStore.getState().quickTerminalTabs.map((t) => t.label);
    expect(labels).toContain("Terminal");
    expect(labels).toContain("Terminal 3");
    expect(labels).toContain("Terminal 4");
  });
});

// ─── Reset ──────────────────────────────────────────────────────────────────

describe("reset", () => {
  it("clears all maps and resets state", () => {
    // Populate many fields
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().setCurrentSession("s1");
    useStore.getState().appendMessage("s1", makeMessage());
    useStore.getState().setStreaming("s1", "text");
    useStore.getState().setStreamingStats("s1", { startedAt: 1, outputTokens: 2 });
    useStore.getState().addPermission("s1", makePermission());
    useStore.getState().addTask("s1", makeTask());
    useStore.getState().setSessionName("s1", "name");
    useStore.getState().markRecentlyRenamed("s1");
    useStore.getState().setConnectionStatus("s1", "connected");
    useStore.getState().setCliConnected("s1", true);
    useStore.getState().setSessionStatus("s1", "running");
    useStore.getState().setPreviousPermissionMode("s1", "default");
    useStore.getState().setSdkSessions([
      { sessionId: "s1", state: "connected", cwd: "/", createdAt: 0 },
    ]);

    useStore.getState().reset();
    const state = useStore.getState();

    expect(state.sessions.size).toBe(0);
    expect(state.sdkSessions).toEqual([]);
    expect(state.currentSessionId).toBeNull();
    expect(state.messages.size).toBe(0);
    expect(state.streaming.size).toBe(0);
    expect(state.streamingStartedAt.size).toBe(0);
    expect(state.streamingOutputTokens.size).toBe(0);
    expect(state.pendingPermissions.size).toBe(0);
    expect(state.connectionStatus.size).toBe(0);
    expect(state.cliConnected.size).toBe(0);
    expect(state.sessionStatus.size).toBe(0);
    expect(state.previousPermissionMode.size).toBe(0);
    expect(state.sessionTasks.size).toBe(0);
    expect(state.sessionNames.size).toBe(0);
    expect(state.recentlyRenamed.size).toBe(0);
    expect(state.mcpServers.size).toBe(0);
  });
});

// ─── MCP Servers ──────────────────────────────────────────────────────────────

describe("MCP Servers", () => {
  it("setMcpServers: stores servers for a session", () => {
    const servers = [
      { name: "test-server", status: "connected" as const, config: { type: "stdio" }, scope: "project" },
    ];
    useStore.getState().setMcpServers("s1", servers);
    expect(useStore.getState().mcpServers.get("s1")).toEqual(servers);
  });

  it("setMcpServers: replaces existing servers", () => {
    const first = [{ name: "old", status: "connected" as const, config: { type: "stdio" }, scope: "project" }];
    const second = [{ name: "new", status: "failed" as const, config: { type: "sse" }, scope: "user" }];
    useStore.getState().setMcpServers("s1", first);
    useStore.getState().setMcpServers("s1", second);
    expect(useStore.getState().mcpServers.get("s1")).toEqual(second);
  });

  it("removeSession: clears mcpServers", () => {
    const servers = [{ name: "test", status: "connected" as const, config: { type: "stdio" }, scope: "project" }];
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().setMcpServers("s1", servers);
    useStore.getState().removeSession("s1");
    expect(useStore.getState().mcpServers.has("s1")).toBe(false);
  });
});
