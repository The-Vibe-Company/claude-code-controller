import { create } from "zustand";
import type { SessionState, PermissionRequest, ChatMessage, SdkSessionInfo, TaskItem, McpServerDetail, PluginInsight } from "./types.js";
import type { UpdateInfo, PRStatusResponse, PluginRuntimeInfo } from "./api.js";
import type { PluginInsightLevel } from "../server/plugins/types.js";

export interface ToastItem {
  id: string;
  title: string;
  message: string;
  level: PluginInsightLevel;
  timestamp: number;
  pluginId: string;
  sessionId?: string;
  dismissed: boolean;
  count: number;
  key: string;
}

interface AppState {
  // Sessions
  sessions: Map<string, SessionState>;
  sdkSessions: SdkSessionInfo[];
  currentSessionId: string | null;

  // Messages per session
  messages: Map<string, ChatMessage[]>;

  // Streaming partial text per session
  streaming: Map<string, string>;

  // Streaming stats: start time + output tokens
  streamingStartedAt: Map<string, number>;
  streamingOutputTokens: Map<string, number>;

  // Pending permissions per session (outer key = sessionId, inner key = request_id)
  pendingPermissions: Map<string, Map<string, PermissionRequest>>;

  // Connection state per session
  connectionStatus: Map<string, "connecting" | "connected" | "disconnected">;
  cliConnected: Map<string, boolean>;

  // Session status
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;

  // Plan mode: stores previous permission mode per session so we can restore it
  previousPermissionMode: Map<string, string>;

  // Tasks per session
  sessionTasks: Map<string, TaskItem[]>;

  // Files changed by the agent per session (Edit/Write tool calls)
  changedFiles: Map<string, Set<string>>;

  // Session display names
  sessionNames: Map<string, string>;
  // Track sessions that were just renamed (for animation)
  recentlyRenamed: Set<string>;

  // PR status per session (pushed by server via WebSocket)
  prStatus: Map<string, PRStatusResponse>;

  // MCP servers per session
  mcpServers: Map<string, McpServerDetail[]>;

  // Plugin insights per session
  pluginInsights: Map<string, PluginInsight[]>;

  // Plugin catalog/config
  plugins: PluginRuntimeInfo[];
  taskbarPluginPins: Set<string>;
  taskbarPluginFocus: string | null;

  // Toast notifications (generic plugin capability)
  toasts: ToastItem[];

  // Notification popover
  notificationPopoverOpen: boolean;
  lastReadInsightTimestamp: Map<string, number>;

  // Sidebar project grouping
  collapsedProjects: Set<string>;

  // Update info
  updateInfo: UpdateInfo | null;
  updateDismissedVersion: string | null;

  // UI
  darkMode: boolean;
  notificationSound: boolean;
  notificationDesktop: boolean;
  sidebarOpen: boolean;
  taskPanelOpen: boolean;
  homeResetKey: number;
  activeTab: "chat" | "diff";
  diffPanelSelectedFile: Map<string, string>;

  // Actions
  setDarkMode: (v: boolean) => void;
  toggleDarkMode: () => void;
  setNotificationSound: (v: boolean) => void;
  toggleNotificationSound: () => void;
  setNotificationDesktop: (v: boolean) => void;
  toggleNotificationDesktop: () => void;
  setSidebarOpen: (v: boolean) => void;
  setTaskPanelOpen: (open: boolean) => void;
  newSession: () => void;

  // Session actions
  setCurrentSession: (id: string | null) => void;
  addSession: (session: SessionState) => void;
  updateSession: (sessionId: string, updates: Partial<SessionState>) => void;
  removeSession: (sessionId: string) => void;
  setSdkSessions: (sessions: SdkSessionInfo[]) => void;

  // Message actions
  appendMessage: (sessionId: string, msg: ChatMessage) => void;
  setMessages: (sessionId: string, msgs: ChatMessage[]) => void;
  updateLastAssistantMessage: (sessionId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  setStreaming: (sessionId: string, text: string | null) => void;
  setStreamingStats: (sessionId: string, stats: { startedAt?: number; outputTokens?: number } | null) => void;

  // Permission actions
  addPermission: (sessionId: string, perm: PermissionRequest) => void;
  removePermission: (sessionId: string, requestId: string) => void;

  // Task actions
  addTask: (sessionId: string, task: TaskItem) => void;
  setTasks: (sessionId: string, tasks: TaskItem[]) => void;
  updateTask: (sessionId: string, taskId: string, updates: Partial<TaskItem>) => void;

  // Changed files actions
  addChangedFile: (sessionId: string, filePath: string) => void;
  clearChangedFiles: (sessionId: string) => void;

  // Session name actions
  setSessionName: (sessionId: string, name: string) => void;
  markRecentlyRenamed: (sessionId: string) => void;
  clearRecentlyRenamed: (sessionId: string) => void;

  // PR status action
  setPRStatus: (sessionId: string, status: PRStatusResponse) => void;

  // MCP actions
  setMcpServers: (sessionId: string, servers: McpServerDetail[]) => void;

  // Plugin actions
  addPluginInsight: (sessionId: string, insight: PluginInsight) => void;
  clearPluginInsights: (sessionId: string) => void;
  setPlugins: (plugins: PluginRuntimeInfo[]) => void;
  setTaskbarPluginPinned: (pluginId: string, pinned: boolean) => void;
  setTaskbarPluginFocus: (pluginId: string | null) => void;

  // Toast actions
  addToast: (insight: PluginInsight) => void;
  dismissToast: (id: string) => void;

  // Notification popover actions
  setNotificationPopoverOpen: (open: boolean) => void;
  markInsightsRead: (sessionId: string) => void;

  // Sidebar project grouping actions
  toggleProjectCollapse: (projectKey: string) => void;

  // Plan mode actions
  setPreviousPermissionMode: (sessionId: string, mode: string) => void;

  // Connection actions
  setConnectionStatus: (sessionId: string, status: "connecting" | "connected" | "disconnected") => void;
  setCliConnected: (sessionId: string, connected: boolean) => void;
  setSessionStatus: (sessionId: string, status: "idle" | "running" | "compacting" | null) => void;

  // Update actions
  setUpdateInfo: (info: UpdateInfo | null) => void;
  dismissUpdate: (version: string) => void;

  // Diff panel actions
  setActiveTab: (tab: "chat" | "diff") => void;
  setDiffPanelSelectedFile: (sessionId: string, filePath: string | null) => void;

  // Terminal state
  terminalOpen: boolean;
  terminalCwd: string | null;
  terminalId: string | null;

  // Terminal actions
  setTerminalOpen: (open: boolean) => void;
  setTerminalCwd: (cwd: string | null) => void;
  setTerminalId: (id: string | null) => void;
  openTerminal: (cwd: string) => void;
  closeTerminal: () => void;

  reset: () => void;
}

function getInitialSessionNames(): Map<string, string> {
  if (typeof window === "undefined") return new Map();
  try {
    return new Map(JSON.parse(localStorage.getItem("cc-session-names") || "[]"));
  } catch {
    return new Map();
  }
}

function getInitialSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("cc-current-session") || null;
}

function getInitialDarkMode(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem("cc-dark-mode");
  if (stored !== null) return stored === "true";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getInitialNotificationSound(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem("cc-notification-sound");
  if (stored !== null) return stored === "true";
  return true;
}

function getInitialNotificationDesktop(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem("cc-notification-desktop");
  if (stored !== null) return stored === "true";
  return false;
}

function getInitialDismissedVersion(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("cc-update-dismissed") || null;
}

function getInitialCollapsedProjects(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set(JSON.parse(localStorage.getItem("cc-collapsed-projects") || "[]"));
  } catch {
    return new Set();
  }
}

function getInitialTaskbarPluginPins(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set(JSON.parse(localStorage.getItem("cc-taskbar-plugin-pins") || "[]"));
  } catch {
    return new Set();
  }
}

export const useStore = create<AppState>((set) => ({
  sessions: new Map(),
  sdkSessions: [],
  currentSessionId: getInitialSessionId(),
  messages: new Map(),
  streaming: new Map(),
  streamingStartedAt: new Map(),
  streamingOutputTokens: new Map(),
  pendingPermissions: new Map(),
  connectionStatus: new Map(),
  cliConnected: new Map(),
  sessionStatus: new Map(),
  previousPermissionMode: new Map(),
  sessionTasks: new Map(),
  changedFiles: new Map(),
  sessionNames: getInitialSessionNames(),
  recentlyRenamed: new Set(),
  prStatus: new Map(),
  mcpServers: new Map(),
  pluginInsights: new Map(),
  plugins: [],
  taskbarPluginPins: getInitialTaskbarPluginPins(),
  taskbarPluginFocus: null,
  toasts: [],
  notificationPopoverOpen: false,
  lastReadInsightTimestamp: new Map(),
  collapsedProjects: getInitialCollapsedProjects(),
  updateInfo: null,
  updateDismissedVersion: getInitialDismissedVersion(),
  darkMode: getInitialDarkMode(),
  notificationSound: getInitialNotificationSound(),
  notificationDesktop: getInitialNotificationDesktop(),
  sidebarOpen: typeof window !== "undefined" ? window.innerWidth >= 768 : true,
  taskPanelOpen: typeof window !== "undefined" ? window.innerWidth >= 1024 : false,
  homeResetKey: 0,
  activeTab: "chat",
  diffPanelSelectedFile: new Map(),
  terminalOpen: false,
  terminalCwd: null,
  terminalId: null,

  setDarkMode: (v) => {
    localStorage.setItem("cc-dark-mode", String(v));
    set({ darkMode: v });
  },
  toggleDarkMode: () =>
    set((s) => {
      const next = !s.darkMode;
      localStorage.setItem("cc-dark-mode", String(next));
      return { darkMode: next };
    }),
  setNotificationSound: (v) => {
    localStorage.setItem("cc-notification-sound", String(v));
    set({ notificationSound: v });
  },
  toggleNotificationSound: () =>
    set((s) => {
      const next = !s.notificationSound;
      localStorage.setItem("cc-notification-sound", String(next));
      return { notificationSound: next };
    }),
  setNotificationDesktop: (v) => {
    localStorage.setItem("cc-notification-desktop", String(v));
    set({ notificationDesktop: v });
  },
  toggleNotificationDesktop: () =>
    set((s) => {
      const next = !s.notificationDesktop;
      localStorage.setItem("cc-notification-desktop", String(next));
      return { notificationDesktop: next };
    }),
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  setTaskPanelOpen: (open) => set({ taskPanelOpen: open }),
  newSession: () => {
    localStorage.removeItem("cc-current-session");
    set((s) => ({ currentSessionId: null, homeResetKey: s.homeResetKey + 1 }));
  },

  setCurrentSession: (id) => {
    if (id) {
      localStorage.setItem("cc-current-session", id);
    } else {
      localStorage.removeItem("cc-current-session");
    }
    set({ currentSessionId: id });
  },

  addSession: (session) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      sessions.set(session.session_id, session);
      const messages = new Map(s.messages);
      if (!messages.has(session.session_id)) messages.set(session.session_id, []);
      return { sessions, messages };
    }),

  updateSession: (sessionId, updates) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      const existing = sessions.get(sessionId);
      if (existing) sessions.set(sessionId, { ...existing, ...updates });
      return { sessions };
    }),

  removeSession: (sessionId) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      sessions.delete(sessionId);
      const messages = new Map(s.messages);
      messages.delete(sessionId);
      const streaming = new Map(s.streaming);
      streaming.delete(sessionId);
      const streamingStartedAt = new Map(s.streamingStartedAt);
      streamingStartedAt.delete(sessionId);
      const streamingOutputTokens = new Map(s.streamingOutputTokens);
      streamingOutputTokens.delete(sessionId);
      const connectionStatus = new Map(s.connectionStatus);
      connectionStatus.delete(sessionId);
      const cliConnected = new Map(s.cliConnected);
      cliConnected.delete(sessionId);
      const sessionStatus = new Map(s.sessionStatus);
      sessionStatus.delete(sessionId);
      const previousPermissionMode = new Map(s.previousPermissionMode);
      previousPermissionMode.delete(sessionId);
      const pendingPermissions = new Map(s.pendingPermissions);
      pendingPermissions.delete(sessionId);
      const sessionTasks = new Map(s.sessionTasks);
      sessionTasks.delete(sessionId);
      const changedFiles = new Map(s.changedFiles);
      changedFiles.delete(sessionId);
      const sessionNames = new Map(s.sessionNames);
      sessionNames.delete(sessionId);
      const recentlyRenamed = new Set(s.recentlyRenamed);
      recentlyRenamed.delete(sessionId);
      const diffPanelSelectedFile = new Map(s.diffPanelSelectedFile);
      diffPanelSelectedFile.delete(sessionId);
      const mcpServers = new Map(s.mcpServers);
      mcpServers.delete(sessionId);
      const pluginInsights = new Map(s.pluginInsights);
      pluginInsights.delete(sessionId);
      const prStatus = new Map(s.prStatus);
      prStatus.delete(sessionId);
      localStorage.setItem("cc-session-names", JSON.stringify(Array.from(sessionNames.entries())));
      if (s.currentSessionId === sessionId) {
        localStorage.removeItem("cc-current-session");
      }
      return {
        sessions,
        messages,
        streaming,
        streamingStartedAt,
        streamingOutputTokens,
        connectionStatus,
        cliConnected,
        sessionStatus,
        previousPermissionMode,
        pendingPermissions,
        sessionTasks,
        changedFiles,
        sessionNames,
        recentlyRenamed,
        diffPanelSelectedFile,
        mcpServers,
        pluginInsights,
        prStatus,
        sdkSessions: s.sdkSessions.filter((sdk) => sdk.sessionId !== sessionId),
        currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
      };
    }),

  setSdkSessions: (sessions) => set({ sdkSessions: sessions }),

  appendMessage: (sessionId, msg) =>
    set((s) => {
      const existing = s.messages.get(sessionId) || [];
      // Deduplicate: skip if a message with same ID already exists
      if (msg.id && existing.some((m) => m.id === msg.id)) {
        return s;
      }
      const messages = new Map(s.messages);
      messages.set(sessionId, [...existing, msg]);
      return { messages };
    }),

  setMessages: (sessionId, msgs) =>
    set((s) => {
      const messages = new Map(s.messages);
      messages.set(sessionId, msgs);
      return { messages };
    }),

  updateLastAssistantMessage: (sessionId, updater) =>
    set((s) => {
      const messages = new Map(s.messages);
      const list = [...(messages.get(sessionId) || [])];
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].role === "assistant") {
          list[i] = updater(list[i]);
          break;
        }
      }
      messages.set(sessionId, list);
      return { messages };
    }),

  setStreaming: (sessionId, text) =>
    set((s) => {
      const streaming = new Map(s.streaming);
      if (text === null) {
        streaming.delete(sessionId);
      } else {
        streaming.set(sessionId, text);
      }
      return { streaming };
    }),

  setStreamingStats: (sessionId, stats) =>
    set((s) => {
      const streamingStartedAt = new Map(s.streamingStartedAt);
      const streamingOutputTokens = new Map(s.streamingOutputTokens);
      if (stats === null) {
        streamingStartedAt.delete(sessionId);
        streamingOutputTokens.delete(sessionId);
      } else {
        if (stats.startedAt !== undefined) streamingStartedAt.set(sessionId, stats.startedAt);
        if (stats.outputTokens !== undefined) streamingOutputTokens.set(sessionId, stats.outputTokens);
      }
      return { streamingStartedAt, streamingOutputTokens };
    }),

  addPermission: (sessionId, perm) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      const sessionPerms = new Map(pendingPermissions.get(sessionId) || []);
      sessionPerms.set(perm.request_id, perm);
      pendingPermissions.set(sessionId, sessionPerms);
      return { pendingPermissions };
    }),

  removePermission: (sessionId, requestId) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      const sessionPerms = pendingPermissions.get(sessionId);
      if (sessionPerms) {
        const updated = new Map(sessionPerms);
        updated.delete(requestId);
        pendingPermissions.set(sessionId, updated);
      }
      return { pendingPermissions };
    }),

  addTask: (sessionId, task) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      const tasks = [...(sessionTasks.get(sessionId) || []), task];
      sessionTasks.set(sessionId, tasks);
      return { sessionTasks };
    }),

  setTasks: (sessionId, tasks) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      sessionTasks.set(sessionId, tasks);
      return { sessionTasks };
    }),

  updateTask: (sessionId, taskId, updates) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      const tasks = sessionTasks.get(sessionId);
      if (tasks) {
        sessionTasks.set(
          sessionId,
          tasks.map((t) => (t.id === taskId ? { ...t, ...updates } : t)),
        );
      }
      return { sessionTasks };
    }),

  addChangedFile: (sessionId, filePath) =>
    set((s) => {
      const changedFiles = new Map(s.changedFiles);
      const files = new Set(changedFiles.get(sessionId) || []);
      files.add(filePath);
      changedFiles.set(sessionId, files);
      return { changedFiles };
    }),

  clearChangedFiles: (sessionId) =>
    set((s) => {
      const changedFiles = new Map(s.changedFiles);
      changedFiles.delete(sessionId);
      return { changedFiles };
    }),

  setSessionName: (sessionId, name) =>
    set((s) => {
      const sessionNames = new Map(s.sessionNames);
      sessionNames.set(sessionId, name);
      localStorage.setItem("cc-session-names", JSON.stringify(Array.from(sessionNames.entries())));
      return { sessionNames };
    }),

  markRecentlyRenamed: (sessionId) =>
    set((s) => {
      const recentlyRenamed = new Set(s.recentlyRenamed);
      recentlyRenamed.add(sessionId);
      return { recentlyRenamed };
    }),

  clearRecentlyRenamed: (sessionId) =>
    set((s) => {
      const recentlyRenamed = new Set(s.recentlyRenamed);
      recentlyRenamed.delete(sessionId);
      return { recentlyRenamed };
    }),

  setPRStatus: (sessionId, status) =>
    set((s) => {
      const prStatus = new Map(s.prStatus);
      prStatus.set(sessionId, status);
      return { prStatus };
    }),

  setMcpServers: (sessionId, servers) =>
    set((s) => {
      const mcpServers = new Map(s.mcpServers);
      mcpServers.set(sessionId, servers);
      return { mcpServers };
    }),

  addPluginInsight: (sessionId, insight) =>
    set((s) => {
      const pluginInsights = new Map(s.pluginInsights);
      const list = [...(pluginInsights.get(sessionId) || []), insight];
      // Keep panel light and bounded.
      if (list.length > 100) list.splice(0, list.length - 100);
      pluginInsights.set(sessionId, list);
      return { pluginInsights };
    }),

  clearPluginInsights: (sessionId) =>
    set((s) => {
      const pluginInsights = new Map(s.pluginInsights);
      pluginInsights.delete(sessionId);
      return { pluginInsights };
    }),

  setPlugins: (plugins) => set({ plugins }),

  setTaskbarPluginPinned: (pluginId, pinned) =>
    set((s) => {
      const taskbarPluginPins = new Set(s.taskbarPluginPins);
      if (pinned) {
        taskbarPluginPins.add(pluginId);
      } else {
        taskbarPluginPins.delete(pluginId);
      }
      localStorage.setItem("cc-taskbar-plugin-pins", JSON.stringify(Array.from(taskbarPluginPins)));
      return { taskbarPluginPins };
    }),

  setTaskbarPluginFocus: (pluginId) => set({ taskbarPluginFocus: pluginId }),

  addToast: (insight) =>
    set((s) => {
      const key = `${insight.plugin_id}:${insight.title}`;
      const now = Date.now();
      // Dedup: merge with existing toast if same key within 2 seconds
      const recent = s.toasts.find(
        (t) => !t.dismissed && t.key === key && now - t.timestamp < 2000,
      );
      if (recent) {
        return {
          toasts: s.toasts.map((t) =>
            t.id === recent.id
              ? { ...t, count: t.count + 1, message: insight.message, timestamp: now }
              : t,
          ),
        };
      }
      const toast: ToastItem = {
        id: insight.id,
        title: insight.title,
        message: insight.message,
        level: insight.level,
        timestamp: now,
        pluginId: insight.plugin_id,
        sessionId: insight.session_id,
        dismissed: false,
        count: 1,
        key,
      };
      // Cap at 5 visible toasts
      const toasts = [...s.toasts.filter((t) => !t.dismissed), toast].slice(-5);
      return { toasts };
    }),

  dismissToast: (id) =>
    set((s) => ({
      toasts: s.toasts.map((t) => (t.id === id ? { ...t, dismissed: true } : t)),
    })),

  setNotificationPopoverOpen: (open) => set({ notificationPopoverOpen: open }),

  markInsightsRead: (sessionId) =>
    set((s) => {
      const lastReadInsightTimestamp = new Map(s.lastReadInsightTimestamp);
      lastReadInsightTimestamp.set(sessionId, Date.now());
      return { lastReadInsightTimestamp };
    }),

  toggleProjectCollapse: (projectKey) =>
    set((s) => {
      const collapsedProjects = new Set(s.collapsedProjects);
      if (collapsedProjects.has(projectKey)) {
        collapsedProjects.delete(projectKey);
      } else {
        collapsedProjects.add(projectKey);
      }
      localStorage.setItem("cc-collapsed-projects", JSON.stringify(Array.from(collapsedProjects)));
      return { collapsedProjects };
    }),

  setPreviousPermissionMode: (sessionId, mode) =>
    set((s) => {
      const previousPermissionMode = new Map(s.previousPermissionMode);
      previousPermissionMode.set(sessionId, mode);
      return { previousPermissionMode };
    }),

  setConnectionStatus: (sessionId, status) =>
    set((s) => {
      const connectionStatus = new Map(s.connectionStatus);
      connectionStatus.set(sessionId, status);
      return { connectionStatus };
    }),

  setCliConnected: (sessionId, connected) =>
    set((s) => {
      const cliConnected = new Map(s.cliConnected);
      cliConnected.set(sessionId, connected);
      return { cliConnected };
    }),

  setSessionStatus: (sessionId, status) =>
    set((s) => {
      const sessionStatus = new Map(s.sessionStatus);
      sessionStatus.set(sessionId, status);
      return { sessionStatus };
    }),

  setUpdateInfo: (info) => set({ updateInfo: info }),
  dismissUpdate: (version) => {
    localStorage.setItem("cc-update-dismissed", version);
    set({ updateDismissedVersion: version });
  },

  setActiveTab: (tab) => set({ activeTab: tab }),

  setDiffPanelSelectedFile: (sessionId, filePath) =>
    set((s) => {
      const diffPanelSelectedFile = new Map(s.diffPanelSelectedFile);
      if (filePath) {
        diffPanelSelectedFile.set(sessionId, filePath);
      } else {
        diffPanelSelectedFile.delete(sessionId);
      }
      return { diffPanelSelectedFile };
    }),

  setTerminalOpen: (open) => set({ terminalOpen: open }),
  setTerminalCwd: (cwd) => set({ terminalCwd: cwd }),
  setTerminalId: (id) => set({ terminalId: id }),
  openTerminal: (cwd) => set({ terminalOpen: true, terminalCwd: cwd }),
  closeTerminal: () => set({ terminalOpen: false, terminalCwd: null, terminalId: null }),

  reset: () =>
    set({
      sessions: new Map(),
      sdkSessions: [],
      currentSessionId: null,
      messages: new Map(),
      streaming: new Map(),
      streamingStartedAt: new Map(),
      streamingOutputTokens: new Map(),
      pendingPermissions: new Map(),
      connectionStatus: new Map(),
      cliConnected: new Map(),
      sessionStatus: new Map(),
      previousPermissionMode: new Map(),
      sessionTasks: new Map(),
      changedFiles: new Map(),
      sessionNames: new Map(),
      recentlyRenamed: new Set(),
      mcpServers: new Map(),
      pluginInsights: new Map(),
      plugins: [],
      taskbarPluginPins: getInitialTaskbarPluginPins(),
      taskbarPluginFocus: null,
      toasts: [],
      notificationPopoverOpen: false,
      lastReadInsightTimestamp: new Map(),
      prStatus: new Map(),
      activeTab: "chat" as const,
      diffPanelSelectedFile: new Map(),
      terminalOpen: false,
      terminalCwd: null,
      terminalId: null,
    }),
}));
