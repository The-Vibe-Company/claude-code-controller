import type { ServerWebSocket } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import type {
  CLIMessage,
  CLISystemInitMessage,
  CLISystemStatusMessage,
  CLIAssistantMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLIToolProgressMessage,
  CLIToolUseSummaryMessage,
  CLIControlRequestMessage,
  CLIControlResponseMessage,
  CLIAuthStatusMessage,
  BrowserOutgoingMessage,
  BrowserIncomingMessage,
  ReplayableBrowserIncomingMessage,
  BufferedBrowserEvent,
  SessionState,
  PermissionRequest,
  BackendType,
  McpServerDetail,
  McpServerConfig,
  PluginInsight,
} from "./session-types.js";
import type { SessionStore } from "./session-store.js";
import type { CodexAdapter } from "./codex-adapter.js";
import type { EmitResult, PluginManager } from "./plugins/manager.js";
import type { PluginEvent } from "./plugins/types.js";

// ─── WebSocket data tags ──────────────────────────────────────────────────────

interface CLISocketData {
  kind: "cli";
  sessionId: string;
}

interface BrowserSocketData {
  kind: "browser";
  sessionId: string;
  subscribed?: boolean;
  lastAckSeq?: number;
}

interface TerminalSocketData {
  kind: "terminal";
  terminalId: string;
}

export type SocketData = CLISocketData | BrowserSocketData | TerminalSocketData;

// ─── Session ──────────────────────────────────────────────────────────────────

/** Tracks a pending control_request sent to CLI that expects a control_response. */
interface PendingControlRequest {
  subtype: string;
  resolve: (response: unknown) => void;
}

interface Session {
  id: string;
  backendType: BackendType;
  cliSocket: ServerWebSocket<SocketData> | null;
  codexAdapter: CodexAdapter | null;
  browserSockets: Set<ServerWebSocket<SocketData>>;
  state: SessionState;
  pendingPermissions: Map<string, PermissionRequest>;
  /** Pending control_requests sent TO CLI, keyed by request_id */
  pendingControlRequests: Map<string, PendingControlRequest>;
  messageHistory: BrowserIncomingMessage[];
  /** Messages queued while waiting for CLI to connect */
  pendingMessages: string[];
  /** Monotonic sequence for broadcast events */
  nextEventSeq: number;
  /** Recent broadcast events for reconnect replay */
  eventBuffer: BufferedBrowserEvent[];
  /** Highest acknowledged seq seen from any browser for this session */
  lastAckSeq: number;
  /** Recently processed browser client_msg_id values for idempotency on reconnect retries */
  processedClientMessageIds: string[];
  processedClientMessageIdSet: Set<string>;
  /** tool_use_id values that already emitted tool.started */
  startedToolUseIds: Set<string>;
  /** Sequential chain to preserve user message ordering when middleware is async. */
  userMessageChain: Promise<void>;
}

type GitSessionKey = "git_branch" | "is_worktree" | "repo_root" | "git_ahead" | "git_behind";

function makeDefaultState(sessionId: string, backendType: BackendType = "claude"): SessionState {
  return {
    session_id: sessionId,
    backend_type: backendType,
    model: "",
    cwd: "",
    tools: [],
    permissionMode: "default",
    claude_code_version: "",
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
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

// ─── Git info helper ─────────────────────────────────────────────────────────

function resolveGitInfo(state: SessionState): void {
  if (!state.cwd) return;
  try {
    state.git_branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: state.cwd, encoding: "utf-8", timeout: 3000,
    }).trim();

    try {
      const gitDir = execSync("git rev-parse --git-dir", {
        cwd: state.cwd, encoding: "utf-8", timeout: 3000,
      }).trim();
      state.is_worktree = gitDir.includes("/worktrees/");
    } catch { /* ignore */ }

    try {
      if (state.is_worktree) {
        // For worktrees, --show-toplevel returns the worktree dir, not the original repo.
        // Use --git-common-dir to find the shared .git dir, then derive the repo root.
        const commonDir = execSync("git rev-parse --git-common-dir", {
          cwd: state.cwd, encoding: "utf-8", timeout: 3000,
        }).trim();
        state.repo_root = resolve(state.cwd, commonDir, "..");
      } else {
        state.repo_root = execSync("git rev-parse --show-toplevel", {
          cwd: state.cwd, encoding: "utf-8", timeout: 3000,
        }).trim();
      }
    } catch { /* ignore */ }

    try {
      const counts = execSync(
        "git rev-list --left-right --count @{upstream}...HEAD",
        { cwd: state.cwd, encoding: "utf-8", timeout: 3000 },
      ).trim();
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      state.git_ahead = ahead || 0;
      state.git_behind = behind || 0;
    } catch {
      state.git_ahead = 0;
      state.git_behind = 0;
    }
  } catch {
    // Not a git repo or git not available
    state.git_branch = "";
    state.is_worktree = false;
    state.repo_root = "";
    state.git_ahead = 0;
    state.git_behind = 0;
  }
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

export class WsBridge {
  private static readonly EVENT_BUFFER_LIMIT = 600;
  private static readonly PROCESSED_CLIENT_MSG_ID_LIMIT = 1000;
  private static readonly IDEMPOTENT_BROWSER_MESSAGE_TYPES = new Set<string>([
    "user_message",
    "permission_response",
    "interrupt",
    "set_model",
    "set_permission_mode",
    "mcp_get_status",
    "mcp_toggle",
    "mcp_reconnect",
    "mcp_set_servers",
  ]);
  private sessions = new Map<string, Session>();
  private store: SessionStore | null = null;
  private onCLISessionId: ((sessionId: string, cliSessionId: string) => void) | null = null;
  private onCLIRelaunchNeeded: ((sessionId: string) => void) | null = null;
  private onFirstTurnCompleted: ((sessionId: string, firstUserMessage: string) => void) | null = null;
  private autoNamingAttempted = new Set<string>();
  private userMsgCounter = 0;
  private onGitInfoReady: ((sessionId: string, cwd: string, branch: string) => void) | null = null;
  private pluginManager: PluginManager | null = null;
  private static readonly GIT_SESSION_KEYS: GitSessionKey[] = [
    "git_branch",
    "is_worktree",
    "repo_root",
    "git_ahead",
    "git_behind",
  ];

  /** Register a callback for when we learn the CLI's internal session ID. */
  onCLISessionIdReceived(cb: (sessionId: string, cliSessionId: string) => void): void {
    this.onCLISessionId = cb;
  }

  /** Register a callback for when a browser connects but CLI is dead. */
  onCLIRelaunchNeededCallback(cb: (sessionId: string) => void): void {
    this.onCLIRelaunchNeeded = cb;
  }

  /** Register a callback for when a session completes its first turn. */
  onFirstTurnCompletedCallback(cb: (sessionId: string, firstUserMessage: string) => void): void {
    this.onFirstTurnCompleted = cb;
  }

  /** Register a callback for when git info is resolved and branch is known. */
  onSessionGitInfoReadyCallback(cb: (sessionId: string, cwd: string, branch: string) => void): void {
    this.onGitInfoReady = cb;
  }

  /** Push a message to all connected browsers for a session (public, for PRPoller etc.). */
  broadcastToSession(sessionId: string, msg: BrowserIncomingMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.broadcastToBrowsers(session, msg);
  }

  /** Attach a persistent store. Call restoreFromDisk() after. */
  setStore(store: SessionStore): void {
    this.store = store;
  }

  setPluginManager(pluginManager: PluginManager): void {
    this.pluginManager = pluginManager;
  }

  /** Restore sessions from disk (call once at startup). */
  restoreFromDisk(): number {
    if (!this.store) return 0;
    const persisted = this.store.loadAll();
    let count = 0;
    for (const p of persisted) {
      if (this.sessions.has(p.id)) continue; // don't overwrite live sessions
      const session: Session = {
        id: p.id,
        backendType: p.state.backend_type || "claude",
        cliSocket: null,
        codexAdapter: null,
        browserSockets: new Set(),
        state: p.state,
        pendingPermissions: new Map(p.pendingPermissions || []),
        pendingControlRequests: new Map(),
        messageHistory: p.messageHistory || [],
        pendingMessages: p.pendingMessages || [],
        nextEventSeq: p.nextEventSeq && p.nextEventSeq > 0 ? p.nextEventSeq : 1,
        eventBuffer: Array.isArray(p.eventBuffer) ? p.eventBuffer : [],
        lastAckSeq: typeof p.lastAckSeq === "number" ? p.lastAckSeq : 0,
        processedClientMessageIds: Array.isArray(p.processedClientMessageIds) ? p.processedClientMessageIds : [],
        processedClientMessageIdSet: new Set(
          Array.isArray(p.processedClientMessageIds) ? p.processedClientMessageIds : [],
        ),
        startedToolUseIds: new Set(),
        userMessageChain: Promise.resolve(),
      };
      session.state.backend_type = session.backendType;
      // Resolve git info for restored sessions (may have been persisted without it)
      resolveGitInfo(session.state);
      this.sessions.set(p.id, session);
      // Restored sessions with completed turns don't need auto-naming re-triggered
      if (session.state.num_turns > 0) {
        this.autoNamingAttempted.add(session.id);
      }
      count++;
    }
    if (count > 0) {
      console.log(`[ws-bridge] Restored ${count} session(s) from disk`);
    }
    return count;
  }

  /** Persist a session to disk (debounced). */
  private persistSession(session: Session): void {
    if (!this.store) return;
    this.store.save({
      id: session.id,
      state: session.state,
      messageHistory: session.messageHistory,
      pendingMessages: session.pendingMessages,
      pendingPermissions: Array.from(session.pendingPermissions.entries()),
      eventBuffer: session.eventBuffer,
      nextEventSeq: session.nextEventSeq,
      lastAckSeq: session.lastAckSeq,
      processedClientMessageIds: session.processedClientMessageIds,
    });
  }

  private createPluginEvent<T extends PluginEvent["name"]>(
    name: T,
    data: Extract<PluginEvent, { name: T }>["data"],
    options: {
      source: "routes" | "ws-bridge" | "codex-adapter" | "plugin-manager";
      sessionId?: string;
      backendType?: BackendType;
      correlationId?: string;
    },
  ): Extract<PluginEvent, { name: T }> {
    const event = {
      name,
      meta: {
        eventId: randomUUID(),
        eventVersion: 2 as const,
        timestamp: Date.now(),
        source: options.source,
        sessionId: options.sessionId,
        backendType: options.backendType,
        correlationId: options.correlationId,
      },
      data,
    };
    return event as unknown as Extract<PluginEvent, { name: T }>;
  }

  private async emitPluginEvent(event: PluginEvent): Promise<EmitResult> {
    if (!this.pluginManager) return { insights: [], aborted: false };
    const sessionId = event.meta.sessionId;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    try {
      const result = await this.pluginManager.emit(event, {
        onInsight: (insight) => {
          if (session) {
            this.broadcastPluginInsights(session, [insight as PluginInsight]);
          }
        },
      });
      return {
        insights: result.insights as PluginInsight[],
        permissionDecision: result.permissionDecision,
        userMessageMutation: result.userMessageMutation,
        aborted: result.aborted,
      };
    } catch (err) {
      console.error(`[ws-bridge] Plugin event emit failed (${event.name}):`, err);
      if (session) {
        this.broadcastPluginInsights(session, [{
          id: `plugin-manager-${Date.now()}-emit-error`,
          plugin_id: "plugin-manager",
          title: "Plugin system error",
          message: `Failed to process plugin event "${event.name}".`,
          level: "error",
          timestamp: Date.now(),
          session_id: session.id,
          event_name: event.name,
        }]);
      }
      // Never propagate plugin runtime errors to event callers.
      // This avoids dropping permission requests if plugin processing fails.
      return { insights: [], aborted: false };
    }
  }

  private broadcastPluginInsights(session: Session, insights: PluginInsight[]): void {
    for (const insight of insights) {
      this.broadcastToBrowsers(session, { type: "plugin_insight", insight });
    }
  }

  private normalizeToolInput(input: Record<string, unknown>): { command?: string; filePath?: string } {
    return {
      command: typeof input.command === "string" ? input.command : undefined,
      filePath: typeof input.file_path === "string" ? input.file_path : undefined,
    };
  }

  private hashPermissionRequest(perm: PermissionRequest): string {
    const normalized = this.normalizeToolInput(perm.input);
    return createHash("sha256")
      .update(JSON.stringify({
        tool: perm.tool_name,
        command: normalized.command || "",
        filePath: normalized.filePath || "",
      }))
      .digest("hex");
  }

  private handlePermissionAbort(
    session: Session,
    options: { requestId: string; source: "ws-bridge" | "codex-adapter" },
  ): void {
    const message = "Plugin execution aborted while evaluating permission request.";
    if (options.source === "codex-adapter") {
      if (session.codexAdapter) {
        session.codexAdapter.sendBrowserMessage({
          type: "permission_response",
          request_id: options.requestId,
          behavior: "deny",
          message,
          client_msg_id: `plugin-abort-${Date.now()}`,
        });
      }
      void this.emitPluginEvent(this.createPluginEvent(
        "permission.responded",
        {
          sessionId: session.id,
          backendType: session.backendType,
          requestId: options.requestId,
          behavior: "deny",
          automated: true,
          pluginId: "plugin-manager",
          message,
        },
        {
          source: "codex-adapter",
          sessionId: session.id,
          backendType: session.backendType,
          correlationId: options.requestId,
        },
      ));
      return;
    }

    this.handlePermissionResponse(session, {
      type: "permission_response",
      request_id: options.requestId,
      behavior: "deny",
      message,
      automated: true,
      plugin_id: "plugin-manager",
    });
  }

  private refreshGitInfo(
    session: Session,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean } = {},
  ): void {
    const before = {
      git_branch: session.state.git_branch,
      is_worktree: session.state.is_worktree,
      repo_root: session.state.repo_root,
      git_ahead: session.state.git_ahead,
      git_behind: session.state.git_behind,
    };

    resolveGitInfo(session.state);

    let changed = false;
    for (const key of WsBridge.GIT_SESSION_KEYS) {
      if (session.state[key] !== before[key]) {
        changed = true;
        break;
      }
    }

    if (changed) {
      if (options.broadcastUpdate) {
        this.broadcastToBrowsers(session, {
          type: "session_update",
          session: {
            git_branch: session.state.git_branch,
            is_worktree: session.state.is_worktree,
            repo_root: session.state.repo_root,
            git_ahead: session.state.git_ahead,
            git_behind: session.state.git_behind,
          },
        });
      }
      this.persistSession(session);
    }

    if (options.notifyPoller && session.state.git_branch && session.state.cwd && this.onGitInfoReady) {
      this.onGitInfoReady(session.id, session.state.cwd, session.state.git_branch);
    }
  }

  // ── Session management ──────────────────────────────────────────────────

  getOrCreateSession(sessionId: string, backendType?: BackendType): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const type = backendType || "claude";
      session = {
        id: sessionId,
        backendType: type,
        cliSocket: null,
        codexAdapter: null,
        browserSockets: new Set(),
        state: makeDefaultState(sessionId, type),
        pendingPermissions: new Map(),
        pendingControlRequests: new Map(),
        messageHistory: [],
        pendingMessages: [],
        nextEventSeq: 1,
        eventBuffer: [],
        lastAckSeq: 0,
        processedClientMessageIds: [],
        processedClientMessageIdSet: new Set(),
        startedToolUseIds: new Set(),
        userMessageChain: Promise.resolve(),
      };
      this.sessions.set(sessionId, session);
    } else if (backendType) {
      // Only overwrite backendType when explicitly provided (e.g. attachCodexAdapter)
      // Prevents handleBrowserOpen from resetting codex→claude
      session.backendType = backendType;
      session.state.backend_type = backendType;
    }
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values()).map((s) => s.state);
  }

  getCodexRateLimits(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return session?.codexAdapter?.getRateLimits() ?? null;
  }

  isCliConnected(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.backendType === "codex") {
      return !!session.codexAdapter?.isConnected();
    }
    return !!session.cliSocket;
  }

  removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.autoNamingAttempted.delete(sessionId);
    this.store?.remove(sessionId);
  }

  /**
   * Close all sockets (CLI + browsers) for a session and remove it.
   */
  closeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Close CLI socket (Claude)
    if (session.cliSocket) {
      try { session.cliSocket.close(); } catch {}
      session.cliSocket = null;
    }

    // Disconnect Codex adapter
    if (session.codexAdapter) {
      session.codexAdapter.disconnect().catch(() => {});
      session.codexAdapter = null;
    }

    // Close all browser sockets
    for (const ws of session.browserSockets) {
      try { ws.close(); } catch {}
    }
    session.browserSockets.clear();

    this.sessions.delete(sessionId);
    this.autoNamingAttempted.delete(sessionId);
    this.store?.remove(sessionId);
  }

  // ── Codex adapter attachment ────────────────────────────────────────────

  /**
   * Attach a CodexAdapter to a session. The adapter handles all message
   * translation between the Codex app-server (stdio JSON-RPC) and the
   * browser WebSocket protocol.
   */
  attachCodexAdapter(sessionId: string, adapter: CodexAdapter): void {
    const session = this.getOrCreateSession(sessionId, "codex");
    session.backendType = "codex";
    session.state.backend_type = "codex";
    session.codexAdapter = adapter;

    // Forward translated messages to browsers
    adapter.onBrowserMessage((msg) => {
      if (msg.type === "session_init") {
        session.state = { ...session.state, ...msg.session, backend_type: "codex" };
        this.refreshGitInfo(session, { notifyPoller: true });
        this.persistSession(session);
      } else if (msg.type === "session_update") {
        session.state = { ...session.state, ...msg.session, backend_type: "codex" };
        this.refreshGitInfo(session, { notifyPoller: true });
        this.persistSession(session);
      } else if (msg.type === "status_change") {
        session.state.is_compacting = msg.status === "compacting";
        this.persistSession(session);
        void this.emitPluginEvent(this.createPluginEvent(
          "session.status.changed",
          {
            sessionId: session.id,
            backendType: session.backendType,
            status: msg.status === "compacting" ? "compacting" : (msg.status || "idle"),
          },
          {
            source: "codex-adapter",
            sessionId: session.id,
            backendType: session.backendType,
          },
        )).then((pluginResult) => {
          if (pluginResult.insights.length > 0) {
            this.broadcastPluginInsights(session, pluginResult.insights);
          }
        });
      }

      // Store assistant/result messages in history for replay
      if (msg.type === "assistant") {
        session.messageHistory.push({ ...msg, timestamp: msg.timestamp || Date.now() });
        this.persistSession(session);
      } else if (msg.type === "result") {
        session.messageHistory.push(msg);
        this.persistSession(session);
      }

      // Diagnostic: log tool_use assistant messages
      if (msg.type === "assistant") {
        const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content;
        const hasToolUse = content?.some((b) => b.type === "tool_use");
        if (hasToolUse) {
          console.log(`[ws-bridge] Broadcasting tool_use assistant to ${session.browserSockets.size} browser(s) for session ${session.id}`);
        }
      }

      // Handle permission requests
      if (msg.type === "permission_request") {
        if (!this.pluginManager) {
          session.pendingPermissions.set(msg.request.request_id, msg.request);
          this.persistSession(session);
          this.broadcastToBrowsers(session, msg);
          return;
        }

        const normalizedInput = this.normalizeToolInput(msg.request.input);
        void this.emitPluginEvent(this.createPluginEvent(
          "permission.requested",
          {
            sessionId: session.id,
            permission: msg.request,
            backendType: session.backendType,
            state: session.state,
            permissionMode: session.state.permissionMode,
            requestHash: this.hashPermissionRequest(msg.request),
            toolInputNormalized: normalizedInput,
          },
          {
            source: "codex-adapter",
            sessionId: session.id,
            backendType: session.backendType,
            correlationId: msg.request.request_id,
          },
        )).then((pluginResult) => {
          if (pluginResult.insights.length > 0) {
            this.broadcastPluginInsights(session, pluginResult.insights);
          }

          if (pluginResult.aborted) {
            this.handlePermissionAbort(session, {
              requestId: msg.request.request_id,
              source: "codex-adapter",
            });
            return;
          }

          if (pluginResult.permissionDecision && session.codexAdapter) {
            session.codexAdapter.sendBrowserMessage({
              type: "permission_response",
              request_id: msg.request.request_id,
              behavior: pluginResult.permissionDecision.behavior,
              message: pluginResult.permissionDecision.message,
              updated_input: pluginResult.permissionDecision.updated_input,
              client_msg_id: `plugin-auto-${Date.now()}`,
            });
            void this.emitPluginEvent(this.createPluginEvent(
              "permission.responded",
              {
                sessionId: session.id,
                backendType: session.backendType,
                requestId: msg.request.request_id,
                behavior: pluginResult.permissionDecision.behavior,
                automated: true,
                pluginId: pluginResult.permissionDecision.pluginId,
                message: pluginResult.permissionDecision.message,
              },
              {
                source: "codex-adapter",
                sessionId: session.id,
                backendType: session.backendType,
                correlationId: msg.request.request_id,
              },
            ));
            return;
          }

          if (!session.codexAdapter) {
            return;
          }

          session.pendingPermissions.set(msg.request.request_id, msg.request);
          this.persistSession(session);
          this.broadcastToBrowsers(session, msg);
        }).catch((err: unknown) => {
          console.error(`[ws-bridge] Plugin emit failed in codex permission flow, falling back:`, err);
          if (!session.codexAdapter) {
            return;
          }
          session.pendingPermissions.set(msg.request.request_id, msg.request);
          this.persistSession(session);
          this.broadcastToBrowsers(session, msg);
        });
        return;
      }

      this.broadcastToBrowsers(session, msg);

      // Trigger auto-naming after the first result
      if (
        msg.type === "result" &&
        !(msg.data as { is_error?: boolean }).is_error &&
        this.onFirstTurnCompleted &&
        !this.autoNamingAttempted.has(session.id)
      ) {
        this.autoNamingAttempted.add(session.id);
        const firstUserMsg = session.messageHistory.find((m) => m.type === "user_message");
        if (firstUserMsg && firstUserMsg.type === "user_message") {
          this.onFirstTurnCompleted(session.id, firstUserMsg.content);
        }
      }
    });

    // Handle session metadata updates
    adapter.onSessionMeta((meta) => {
      if (meta.cliSessionId && this.onCLISessionId) {
        this.onCLISessionId(session.id, meta.cliSessionId);
      }
      if (meta.model) session.state.model = meta.model;
      if (meta.cwd) session.state.cwd = meta.cwd;
      session.state.backend_type = "codex";
      this.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });
      this.persistSession(session);
    });

    // Handle disconnect
    adapter.onDisconnect(() => {
      for (const [reqId] of session.pendingPermissions) {
        this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
      }
      session.pendingPermissions.clear();
      session.codexAdapter = null;
      this.persistSession(session);
      console.log(`[ws-bridge] Codex adapter disconnected for session ${sessionId}`);
      this.broadcastToBrowsers(session, { type: "cli_disconnected" });
      void this.emitPluginEvent(this.createPluginEvent(
        "session.disconnected",
        { sessionId, backendType: session.backendType },
        { source: "codex-adapter", sessionId, backendType: session.backendType },
      )).then((pluginResult) => {
        if (pluginResult.insights.length > 0) {
          this.broadcastPluginInsights(session, pluginResult.insights);
        }
      });
    });

    // Flush any messages queued while waiting for the adapter
    if (session.pendingMessages.length > 0) {
      console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) to Codex adapter for session ${sessionId}`);
      const queued = session.pendingMessages.splice(0);
      for (const raw of queued) {
        try {
          const msg = JSON.parse(raw) as BrowserOutgoingMessage;
          adapter.sendBrowserMessage(msg);
        } catch {
          console.warn(`[ws-bridge] Failed to parse queued message for Codex: ${raw.substring(0, 100)}`);
        }
      }
    }

    // Notify browsers that the backend is connected
    this.broadcastToBrowsers(session, { type: "cli_connected" });
    console.log(`[ws-bridge] Codex adapter attached for session ${sessionId}`);
    void this.emitPluginEvent(this.createPluginEvent(
      "session.connected",
      { sessionId, backendType: session.backendType },
      { source: "codex-adapter", sessionId, backendType: session.backendType },
    )).then((pluginResult) => {
      if (pluginResult.insights.length > 0) {
        this.broadcastPluginInsights(session, pluginResult.insights);
      }
    });
  }

  // ── CLI WebSocket handlers ──────────────────────────────────────────────

  handleCLIOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    session.cliSocket = ws;
    console.log(`[ws-bridge] CLI connected for session ${sessionId}`);
    this.broadcastToBrowsers(session, { type: "cli_connected" });
    void this.emitPluginEvent(this.createPluginEvent(
      "session.connected",
      { sessionId, backendType: session.backendType },
      { source: "ws-bridge", sessionId, backendType: session.backendType },
    )).then((pluginResult) => {
      if (pluginResult.insights.length > 0) {
        this.broadcastPluginInsights(session, pluginResult.insights);
      }
    });

    // Flush any messages that were queued while waiting for CLI to connect
    if (session.pendingMessages.length > 0) {
      console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) for session ${sessionId}`);
      for (const ndjson of session.pendingMessages) {
        this.sendToCLI(session, ndjson);
      }
      session.pendingMessages = [];
    }
  }

  handleCLIMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const sessionId = (ws.data as CLISocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // NDJSON: split on newlines, parse each line
    const lines = data.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      let msg: CLIMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        console.warn(`[ws-bridge] Failed to parse CLI message: ${line.substring(0, 200)}`);
        continue;
      }
      this.routeCLIMessage(session, msg);
    }
  }

  handleCLIClose(ws: ServerWebSocket<SocketData>) {
    const sessionId = (ws.data as CLISocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.cliSocket = null;
    console.log(`[ws-bridge] CLI disconnected for session ${sessionId}`);
    this.broadcastToBrowsers(session, { type: "cli_disconnected" });

    // Cancel any pending permission requests
    for (const [reqId] of session.pendingPermissions) {
      this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
    }
    session.pendingPermissions.clear();
    void this.emitPluginEvent(this.createPluginEvent(
      "session.disconnected",
      { sessionId, backendType: session.backendType },
      { source: "ws-bridge", sessionId, backendType: session.backendType },
    )).then((pluginResult) => {
      if (pluginResult.insights.length > 0) {
        this.broadcastPluginInsights(session, pluginResult.insights);
      }
    });
  }

  // ── Browser WebSocket handlers ──────────────────────────────────────────

  handleBrowserOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    const browserData = ws.data as BrowserSocketData;
    browserData.subscribed = false;
    browserData.lastAckSeq = 0;
    session.browserSockets.add(ws);
    console.log(`[ws-bridge] Browser connected for session ${sessionId} (${session.browserSockets.size} browsers)`);

    // Refresh git state on browser connect so branch changes made mid-session are reflected.
    this.refreshGitInfo(session, { notifyPoller: true });

    // Send current session state as snapshot
    const snapshot: BrowserIncomingMessage = {
      type: "session_init",
      session: session.state,
    };
    this.sendToBrowser(ws, snapshot);

    // Replay message history so the browser can reconstruct the conversation
    if (session.messageHistory.length > 0) {
      this.sendToBrowser(ws, {
        type: "message_history",
        messages: session.messageHistory,
      });
    }

    // Send any pending permission requests
    for (const perm of session.pendingPermissions.values()) {
      this.sendToBrowser(ws, { type: "permission_request", request: perm });
    }

    // Notify if backend is not connected and request relaunch
    const backendConnected = session.backendType === "codex"
      // Treat an attached adapter as "alive" during init.
      // `isConnected()` flips true only after initialize/thread start, and
      // relaunching during that window can kill a healthy startup.
      ? !!session.codexAdapter
      : !!session.cliSocket;

    if (!backendConnected) {
      this.sendToBrowser(ws, { type: "cli_disconnected" });
      if (this.onCLIRelaunchNeeded) {
        console.log(`[ws-bridge] Browser connected but backend is dead for session ${sessionId}, requesting relaunch`);
        this.onCLIRelaunchNeeded(sessionId);
      }
    }
  }

  handleBrowserMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    let msg: BrowserOutgoingMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      console.warn(`[ws-bridge] Failed to parse browser message: ${data.substring(0, 200)}`);
      return;
    }

    this.routeBrowserMessage(session, msg, ws);
  }

  handleBrowserClose(ws: ServerWebSocket<SocketData>) {
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.browserSockets.delete(ws);
    console.log(`[ws-bridge] Browser disconnected for session ${sessionId} (${session.browserSockets.size} browsers)`);
  }

  // ── CLI message routing ─────────────────────────────────────────────────

  private routeCLIMessage(session: Session, msg: CLIMessage) {
    switch (msg.type) {
      case "system":
        this.handleSystemMessage(session, msg);
        break;

      case "assistant":
        this.handleAssistantMessage(session, msg);
        break;

      case "result":
        this.handleResultMessage(session, msg);
        break;

      case "stream_event":
        this.handleStreamEvent(session, msg);
        break;

      case "control_request":
        this.handleControlRequest(session, msg);
        break;

      case "tool_progress":
        this.handleToolProgress(session, msg);
        break;

      case "tool_use_summary":
        this.handleToolUseSummary(session, msg);
        break;

      case "auth_status":
        this.handleAuthStatus(session, msg);
        break;

      case "control_response":
        this.handleControlResponse(session, msg);
        break;

      case "keep_alive":
        // Silently consume keepalives
        break;

      default:
        // Forward unknown messages as-is for debugging
        break;
    }
  }

  private handleSystemMessage(session: Session, msg: CLISystemInitMessage | CLISystemStatusMessage) {
    if (msg.subtype === "init") {
      // Keep the launcher-assigned session_id as the canonical ID.
      // The CLI may report its own internal session_id which differs
      // from the launcher UUID, causing duplicate entries in the sidebar.

      // Store the CLI's internal session_id so we can --resume on relaunch
      if (msg.session_id && this.onCLISessionId) {
        this.onCLISessionId(session.id, msg.session_id);
      }

      session.state.model = msg.model;
      session.state.cwd = msg.cwd;
      session.state.tools = msg.tools;
      session.state.permissionMode = msg.permissionMode;
      session.state.claude_code_version = msg.claude_code_version;
      session.state.mcp_servers = msg.mcp_servers;
      session.state.agents = msg.agents ?? [];
      session.state.slash_commands = msg.slash_commands ?? [];
      session.state.skills = msg.skills ?? [];

      // Resolve and publish git info
      this.refreshGitInfo(session, { notifyPoller: true });

      this.broadcastToBrowsers(session, {
        type: "session_init",
        session: session.state,
      });
      this.persistSession(session);
    } else if (msg.subtype === "status") {
      session.state.is_compacting = msg.status === "compacting";

      if (msg.permissionMode) {
        session.state.permissionMode = msg.permissionMode;
      }

      this.broadcastToBrowsers(session, {
        type: "status_change",
        status: msg.status ?? null,
      });
      void this.emitPluginEvent(this.createPluginEvent(
        "session.status.changed",
        {
          sessionId: session.id,
          backendType: session.backendType,
          status: msg.status === "compacting" ? "compacting" : "idle",
        },
        {
          source: "ws-bridge",
          sessionId: session.id,
          backendType: session.backendType,
        },
      )).then((pluginResult) => {
        if (pluginResult.insights.length > 0) {
          this.broadcastPluginInsights(session, pluginResult.insights);
        }
      });
    }
    // Other system subtypes (compact_boundary, task_notification, etc.) can be forwarded as needed
  }

  private handleAssistantMessage(session: Session, msg: CLIAssistantMessage) {
    const browserMsg: BrowserIncomingMessage = {
      type: "assistant",
      message: msg.message,
      parent_tool_use_id: msg.parent_tool_use_id,
      timestamp: Date.now(),
    };
    session.messageHistory.push(browserMsg);
    this.broadcastToBrowsers(session, browserMsg);
    this.persistSession(session);
    const text = msg.message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const toolBlocks = msg.message.content.filter((b) => b.type === "tool_use");
    void this.emitPluginEvent(this.createPluginEvent(
      "message.assistant",
      {
        sessionId: session.id,
        backendType: session.backendType,
        text,
        hasToolUse: toolBlocks.length > 0,
        toolNames: toolBlocks.map((b) => b.name),
      },
      {
        source: "ws-bridge",
        sessionId: session.id,
        backendType: session.backendType,
        correlationId: msg.message.id,
      },
    )).then((pluginResult) => {
      if (pluginResult.insights.length > 0) {
        this.broadcastPluginInsights(session, pluginResult.insights);
      }
    });
  }

  private handleResultMessage(session: Session, msg: CLIResultMessage) {
    // Update session cost/turns
    session.state.total_cost_usd = msg.total_cost_usd;
    session.state.num_turns = msg.num_turns;

    // Update lines changed (CLI may send these in result)
    if (typeof msg.total_lines_added === "number") {
      session.state.total_lines_added = msg.total_lines_added;
    }
    if (typeof msg.total_lines_removed === "number") {
      session.state.total_lines_removed = msg.total_lines_removed;
    }

    // Compute context usage from modelUsage
    if (msg.modelUsage) {
      for (const usage of Object.values(msg.modelUsage)) {
        if (usage.contextWindow > 0) {
          const pct = Math.round(
            ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100
          );
          session.state.context_used_percent = Math.max(0, Math.min(pct, 100));
        }
      }
    }

    // Re-check git state after each turn in case branch moved during the session.
    this.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });

    const browserMsg: BrowserIncomingMessage = {
      type: "result",
      data: msg,
    };
    session.messageHistory.push(browserMsg);
    this.broadcastToBrowsers(session, browserMsg);
    this.persistSession(session);
    void this.emitPluginEvent(this.createPluginEvent(
      "result.received",
      {
        sessionId: session.id,
        backendType: session.backendType,
        result: msg,
        success: !msg.is_error,
        durationMs: msg.duration_ms,
        costUsd: msg.total_cost_usd,
        numTurns: msg.num_turns,
        errorSummary: msg.errors?.join(", "),
      },
      {
        source: "ws-bridge",
        sessionId: session.id,
        backendType: session.backendType,
        correlationId: msg.uuid,
      },
    )).then((pluginResult) => {
      if (pluginResult.insights.length > 0) {
        this.broadcastPluginInsights(session, pluginResult.insights);
      }
    });

    // Trigger auto-naming after the first successful result for this session.
    // Note: num_turns counts all internal tool-use turns, so it's typically > 1
    // even on the first user interaction. We track per-session instead.
    if (
      !msg.is_error &&
      this.onFirstTurnCompleted &&
      !this.autoNamingAttempted.has(session.id)
    ) {
      this.autoNamingAttempted.add(session.id);
      const firstUserMsg = session.messageHistory.find(
        (m) => m.type === "user_message",
      );
      if (firstUserMsg && firstUserMsg.type === "user_message") {
        this.onFirstTurnCompleted(session.id, firstUserMsg.content);
      }
    }
  }

  private handleStreamEvent(session: Session, msg: CLIStreamEventMessage) {
    this.broadcastToBrowsers(session, {
      type: "stream_event",
      event: msg.event,
      parent_tool_use_id: msg.parent_tool_use_id,
    });
  }

  private handleControlRequest(session: Session, msg: CLIControlRequestMessage) {
    if (msg.request.subtype === "can_use_tool") {
      const perm: PermissionRequest = {
        request_id: msg.request_id,
        tool_name: msg.request.tool_name,
        input: msg.request.input,
        permission_suggestions: msg.request.permission_suggestions,
        description: msg.request.description,
        tool_use_id: msg.request.tool_use_id,
        agent_id: msg.request.agent_id,
        timestamp: Date.now(),
      };

      if (!this.pluginManager) {
        session.pendingPermissions.set(msg.request_id, perm);
        this.broadcastToBrowsers(session, {
          type: "permission_request",
          request: perm,
        });
        this.persistSession(session);
        return;
      }

      const normalizedInput = this.normalizeToolInput(perm.input);
      void this.emitPluginEvent(this.createPluginEvent(
        "permission.requested",
        {
          sessionId: session.id,
          permission: perm,
          backendType: session.backendType,
          state: session.state,
          permissionMode: session.state.permissionMode,
          requestHash: this.hashPermissionRequest(perm),
          toolInputNormalized: normalizedInput,
        },
        {
          source: "ws-bridge",
          sessionId: session.id,
          backendType: session.backendType,
          correlationId: msg.request_id,
        },
      )).then((pluginResult) => {
        if (pluginResult.insights.length > 0) {
          this.broadcastPluginInsights(session, pluginResult.insights);
        }

        if (pluginResult.aborted) {
          this.handlePermissionAbort(session, {
            requestId: msg.request_id,
            source: "ws-bridge",
          });
          return;
        }

        if (pluginResult.permissionDecision) {
          this.handlePermissionResponse(session, {
            type: "permission_response",
            request_id: msg.request_id,
            behavior: pluginResult.permissionDecision.behavior,
            message: pluginResult.permissionDecision.message,
            updated_input: pluginResult.permissionDecision.updated_input ?? perm.input,
            plugin_id: pluginResult.permissionDecision.pluginId,
            automated: true,
          });
          return;
        }

        if (!session.cliSocket) {
          return;
        }

        session.pendingPermissions.set(msg.request_id, perm);
        this.broadcastToBrowsers(session, {
          type: "permission_request",
          request: perm,
        });
        this.persistSession(session);
      }).catch((err: unknown) => {
        console.error(`[ws-bridge] Plugin emit failed in Claude permission flow, falling back:`, err);
        if (!session.cliSocket) {
          return;
        }
        session.pendingPermissions.set(msg.request_id, perm);
        this.broadcastToBrowsers(session, {
          type: "permission_request",
          request: perm,
        });
        this.persistSession(session);
      });
    }
  }

  private handleToolProgress(session: Session, msg: CLIToolProgressMessage) {
    if (!session.startedToolUseIds.has(msg.tool_use_id)) {
      session.startedToolUseIds.add(msg.tool_use_id);
      void this.emitPluginEvent(this.createPluginEvent(
        "tool.started",
        {
          sessionId: session.id,
          backendType: session.backendType,
          toolUseId: msg.tool_use_id,
          toolName: msg.tool_name,
          parentToolUseId: msg.parent_tool_use_id,
        },
        {
          source: "ws-bridge",
          sessionId: session.id,
          backendType: session.backendType,
          correlationId: msg.tool_use_id,
        },
      )).then((pluginResult) => {
        if (pluginResult.insights.length > 0) {
          this.broadcastPluginInsights(session, pluginResult.insights);
        }
      });
    }

    this.broadcastToBrowsers(session, {
      type: "tool_progress",
      tool_use_id: msg.tool_use_id,
      tool_name: msg.tool_name,
      elapsed_time_seconds: msg.elapsed_time_seconds,
    });
  }

  private handleToolUseSummary(session: Session, msg: CLIToolUseSummaryMessage) {
    for (const toolUseId of msg.preceding_tool_use_ids) {
      session.startedToolUseIds.delete(toolUseId);
      void this.emitPluginEvent(this.createPluginEvent(
        "tool.finished",
        {
          sessionId: session.id,
          backendType: session.backendType,
          toolUseId,
        },
        {
          source: "ws-bridge",
          sessionId: session.id,
          backendType: session.backendType,
          correlationId: toolUseId,
        },
      )).then((pluginResult) => {
        if (pluginResult.insights.length > 0) {
          this.broadcastPluginInsights(session, pluginResult.insights);
        }
      });
    }

    this.broadcastToBrowsers(session, {
      type: "tool_use_summary",
      summary: msg.summary,
      tool_use_ids: msg.preceding_tool_use_ids,
    });
  }

  private handleAuthStatus(session: Session, msg: CLIAuthStatusMessage) {
    this.broadcastToBrowsers(session, {
      type: "auth_status",
      isAuthenticating: msg.isAuthenticating,
      output: msg.output,
      error: msg.error,
    });
  }

  // ── Browser message routing ─────────────────────────────────────────────

  private routeBrowserMessage(
    session: Session,
    msg: BrowserOutgoingMessage,
    ws?: ServerWebSocket<SocketData>,
  ) {
    if (msg.type === "session_subscribe") {
      this.handleSessionSubscribe(session, ws, msg.last_seq);
      return;
    }

    if (msg.type === "session_ack") {
      this.handleSessionAck(session, ws, msg.last_seq);
      return;
    }

    if (
      WsBridge.IDEMPOTENT_BROWSER_MESSAGE_TYPES.has(msg.type)
      && "client_msg_id" in msg
      && msg.client_msg_id
    ) {
      if (this.isDuplicateClientMessage(session, msg.client_msg_id)) {
        return;
      }
      this.rememberClientMessage(session, msg.client_msg_id);
    }

    if (msg.type === "user_message") {
      this.enqueueUserMessage(session, msg);
      return;
    }

    // For Codex sessions, delegate entirely to the adapter
    if (session.backendType === "codex") {
      if (msg.type === "permission_response") {
        session.pendingPermissions.delete(msg.request_id);
        this.persistSession(session);
        void this.emitPluginEvent(this.createPluginEvent(
          "permission.responded",
          {
            sessionId: session.id,
            backendType: session.backendType,
            requestId: msg.request_id,
            behavior: msg.behavior,
            automated: false,
            message: msg.message,
          },
          {
            source: "ws-bridge",
            sessionId: session.id,
            backendType: session.backendType,
            correlationId: msg.request_id,
          },
        ));
      }

      if (session.codexAdapter) {
        session.codexAdapter.sendBrowserMessage(msg);
      } else {
        // Adapter not yet attached — queue for when it's ready.
        // The adapter itself also queues during init, but this covers
        // the window between session creation and adapter attachment.
        console.log(`[ws-bridge] Codex adapter not yet attached for session ${session.id}, queuing ${msg.type}`);
        session.pendingMessages.push(JSON.stringify(msg));
      }
      return;
    }

    // Claude Code path (existing logic)
    switch (msg.type) {
      case "permission_response":
        this.handlePermissionResponse(session, msg);
        break;

      case "interrupt":
        this.handleInterrupt(session);
        break;

      case "set_model":
        this.handleSetModel(session, msg.model);
        break;

      case "set_permission_mode":
        this.handleSetPermissionMode(session, msg.mode);
        break;

      case "mcp_get_status":
        this.handleMcpGetStatus(session);
        break;

      case "mcp_toggle":
        this.handleMcpToggle(session, msg.serverName, msg.enabled);
        break;

      case "mcp_reconnect":
        this.handleMcpReconnect(session, msg.serverName);
        break;

      case "mcp_set_servers":
        this.handleMcpSetServers(session, msg.servers);
        break;
    }
  }

  private isDuplicateClientMessage(session: Session, clientMsgId: string): boolean {
    return session.processedClientMessageIdSet.has(clientMsgId);
  }

  private rememberClientMessage(session: Session, clientMsgId: string): void {
    session.processedClientMessageIds.push(clientMsgId);
    session.processedClientMessageIdSet.add(clientMsgId);
    if (session.processedClientMessageIds.length > WsBridge.PROCESSED_CLIENT_MSG_ID_LIMIT) {
      const overflow = session.processedClientMessageIds.length - WsBridge.PROCESSED_CLIENT_MSG_ID_LIMIT;
      const removed = session.processedClientMessageIds.splice(0, overflow);
      for (const id of removed) {
        session.processedClientMessageIdSet.delete(id);
      }
    }
    this.persistSession(session);
  }

  private handleSessionSubscribe(
    session: Session,
    ws: ServerWebSocket<SocketData> | undefined,
    lastSeq: number,
  ) {
    if (!ws) return;
    const data = ws.data as BrowserSocketData;
    data.subscribed = true;
    const lastAckSeq = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
    data.lastAckSeq = lastAckSeq;

    if (session.eventBuffer.length === 0) return;
    if (lastAckSeq >= session.nextEventSeq - 1) return;

    const earliest = session.eventBuffer[0]?.seq ?? session.nextEventSeq;
    const hasGap = lastAckSeq > 0 && lastAckSeq < earliest - 1;
    if (hasGap) {
      this.sendToBrowser(ws, {
        type: "message_history",
        messages: session.messageHistory,
      });
      const transientMissed = session.eventBuffer
        .filter((evt) => evt.seq > lastAckSeq && !this.isHistoryBackedEvent(evt.message));
      if (transientMissed.length > 0) {
        this.sendToBrowser(ws, {
          type: "event_replay",
          events: transientMissed,
        });
      }
      return;
    }

    const missed = session.eventBuffer.filter((evt) => evt.seq > lastAckSeq);
    if (missed.length === 0) return;
    this.sendToBrowser(ws, {
      type: "event_replay",
      events: missed,
    });
  }

  private handleSessionAck(
    session: Session,
    ws: ServerWebSocket<SocketData> | undefined,
    lastSeq: number,
  ) {
    const normalized = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
    if (ws) {
      const data = ws.data as BrowserSocketData;
      const prior = typeof data.lastAckSeq === "number" ? data.lastAckSeq : 0;
      data.lastAckSeq = Math.max(prior, normalized);
    }
    if (normalized > session.lastAckSeq) {
      session.lastAckSeq = normalized;
      this.persistSession(session);
    }
  }

  private enqueueUserMessage(
    session: Session,
    msg: { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[] },
  ) {
    if (!this.pluginManager) {
      this.handleUserMessage(session, msg);
      return;
    }
    session.userMessageChain = session.userMessageChain
      .then(() => this.processUserMessage(session, msg))
      .catch((err) => {
        console.error(`[ws-bridge] Failed to process user message for session ${session.id}:`, err);
      });
  }

  private async processUserMessage(
    session: Session,
    msg: { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[] },
  ): Promise<void> {
    const middlewareResult = await this.emitPluginEvent(this.createPluginEvent(
      "user.message.before_send",
      {
        sessionId: session.id,
        backendType: session.backendType,
        state: session.state,
        content: msg.content,
        images: msg.images,
      },
      {
        source: "ws-bridge",
        sessionId: session.id,
        backendType: session.backendType,
      },
    ));
    if (middlewareResult.insights.length > 0) {
      this.broadcastPluginInsights(session, middlewareResult.insights);
    }

    const transformedContent = middlewareResult.userMessageMutation?.content ?? msg.content;
    const transformedImages = middlewareResult.userMessageMutation?.images ?? msg.images;
    const blocked = middlewareResult.aborted || middlewareResult.userMessageMutation?.blocked === true;
    if (blocked) {
      const blockMessage = middlewareResult.userMessageMutation?.message || "Blocked by plugin middleware.";
      const blockPluginId = middlewareResult.userMessageMutation?.pluginId || "plugin-middleware";
      this.broadcastPluginInsights(session, [{
        id: `${blockPluginId}-${Date.now()}-user-blocked`,
        plugin_id: blockPluginId,
        title: "User message blocked",
        message: blockMessage,
        level: "warning",
        timestamp: Date.now(),
        session_id: session.id,
        event_name: "user.message.before_send",
      }]);
      return;
    }

    this.handleUserMessage(session, {
      type: "user_message",
      content: transformedContent,
      session_id: msg.session_id,
      images: transformedImages,
    });
  }

  private handleUserMessage(
    session: Session,
    msg: { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[] }
  ) {
    // Store user message in history for replay with stable ID for dedup on reconnect
    const ts = Date.now();
    session.messageHistory.push({
      type: "user_message",
      content: msg.content,
      timestamp: ts,
      id: `user-${ts}-${this.userMsgCounter++}`,
    });

    if (session.backendType === "codex") {
      if (session.codexAdapter) {
        session.codexAdapter.sendBrowserMessage(msg);
      } else {
        console.log(`[ws-bridge] Codex adapter not yet attached for session ${session.id}, queuing user_message`);
        session.pendingMessages.push(JSON.stringify(msg));
      }
    } else {
      // Build content: if images are present, use content block array; otherwise plain string
      let content: string | unknown[];
      if (msg.images?.length) {
        const blocks: unknown[] = [];
        for (const img of msg.images) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: img.media_type, data: img.data },
          });
        }
        blocks.push({ type: "text", text: msg.content });
        content = blocks;
      } else {
        content = msg.content;
      }

      const ndjson = JSON.stringify({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: msg.session_id || session.state.session_id || "",
      });
      this.sendToCLI(session, ndjson);
    }
    this.persistSession(session);
    void this.emitPluginEvent(this.createPluginEvent(
      "user.message.sent",
      {
        sessionId: session.id,
        backendType: session.backendType,
        content: msg.content,
        hasImages: Array.isArray(msg.images) && msg.images.length > 0,
      },
      {
        source: "ws-bridge",
        sessionId: session.id,
        backendType: session.backendType,
      },
    ));
  }

  private handlePermissionResponse(
    session: Session,
    msg: {
      type: "permission_response";
      request_id: string;
      behavior: "allow" | "deny";
      updated_input?: Record<string, unknown>;
      updated_permissions?: unknown[];
      message?: string;
      automated?: boolean;
      plugin_id?: string;
    }
  ) {
    // Remove from pending
    const pending = session.pendingPermissions.get(msg.request_id);
    session.pendingPermissions.delete(msg.request_id);

    if (msg.behavior === "allow") {
      const response: Record<string, unknown> = {
        behavior: "allow",
        updatedInput: msg.updated_input ?? pending?.input ?? {},
      };
      if (msg.updated_permissions?.length) {
        response.updatedPermissions = msg.updated_permissions;
      }
      const ndjson = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response,
        },
      });
      this.sendToCLI(session, ndjson);
    } else {
      const ndjson = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: {
            behavior: "deny",
            message: msg.message || "Denied by user",
          },
        },
      });
      this.sendToCLI(session, ndjson);
    }

    void this.emitPluginEvent(this.createPluginEvent(
      "permission.responded",
      {
        sessionId: session.id,
        backendType: session.backendType,
        requestId: msg.request_id,
        behavior: msg.behavior,
        automated: msg.automated === true,
        pluginId: msg.plugin_id,
        message: msg.message,
      },
      {
        source: "ws-bridge",
        sessionId: session.id,
        backendType: session.backendType,
        correlationId: msg.request_id,
      },
    )).then((pluginResult) => {
      if (pluginResult.insights.length > 0) {
        this.broadcastPluginInsights(session, pluginResult.insights);
      }
    });
  }

  private handleInterrupt(session: Session) {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
    this.sendToCLI(session, ndjson);
  }

  private handleSetModel(session: Session, model: string) {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_model", model },
    });
    this.sendToCLI(session, ndjson);
  }

  private handleSetPermissionMode(session: Session, mode: string) {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_permission_mode", mode },
    });
    this.sendToCLI(session, ndjson);
  }

  // ── Control response handling ─────────────────────────────────────────

  private handleControlResponse(
    session: Session,
    msg: CLIControlResponseMessage,
  ) {
    const reqId = msg.response.request_id;
    const pending = session.pendingControlRequests.get(reqId);
    if (!pending) return; // Not a request we're tracking
    session.pendingControlRequests.delete(reqId);

    if (msg.response.subtype === "error") {
      console.warn(`[ws-bridge] Control request ${pending.subtype} failed: ${msg.response.error}`);
      return;
    }

    pending.resolve(msg.response.response ?? {});
  }

  // ── MCP control messages ──────────────────────────────────────────────

  /** Send a control_request to CLI, optionally tracking the response via a callback. */
  private sendControlRequest(
    session: Session,
    request: Record<string, unknown>,
    onResponse?: PendingControlRequest,
  ) {
    const requestId = randomUUID();
    if (onResponse) {
      session.pendingControlRequests.set(requestId, onResponse);
    }
    this.sendToCLI(session, JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request,
    }));
  }

  private handleMcpGetStatus(session: Session) {
    this.sendControlRequest(session, { subtype: "mcp_status" }, {
      subtype: "mcp_status",
      resolve: (response) => {
        const servers = (response as { mcpServers?: McpServerDetail[] }).mcpServers ?? [];
        this.broadcastToBrowsers(session, { type: "mcp_status", servers });
        void this.emitPluginEvent(this.createPluginEvent(
          "mcp.status.changed",
          {
            sessionId: session.id,
            backendType: session.backendType,
            servers: servers.map((s) => ({ name: s.name, status: s.status })),
          },
          {
            source: "ws-bridge",
            sessionId: session.id,
            backendType: session.backendType,
          },
        )).then((pluginResult) => {
          if (pluginResult.insights.length > 0) {
            this.broadcastPluginInsights(session, pluginResult.insights);
          }
        });
      },
    });
  }

  private handleMcpToggle(session: Session, serverName: string, enabled: boolean) {
    this.sendControlRequest(session, { subtype: "mcp_toggle", serverName, enabled });
    setTimeout(() => this.handleMcpGetStatus(session), 500);
  }

  private handleMcpReconnect(session: Session, serverName: string) {
    this.sendControlRequest(session, { subtype: "mcp_reconnect", serverName });
    setTimeout(() => this.handleMcpGetStatus(session), 1000);
  }

  private handleMcpSetServers(session: Session, servers: Record<string, McpServerConfig>) {
    this.sendControlRequest(session, { subtype: "mcp_set_servers", servers });
    setTimeout(() => this.handleMcpGetStatus(session), 2000);
  }

  // ── Transport helpers ───────────────────────────────────────────────────

  private sendToCLI(session: Session, ndjson: string) {
    if (!session.cliSocket) {
      // Queue the message — CLI might still be starting up
      console.log(`[ws-bridge] CLI not yet connected for session ${session.id}, queuing message`);
      session.pendingMessages.push(ndjson);
      return;
    }
    try {
      // NDJSON requires a newline delimiter
      session.cliSocket.send(ndjson + "\n");
    } catch (err) {
      console.error(`[ws-bridge] Failed to send to CLI for session ${session.id}:`, err);
    }
  }

  /** Push a session name update to all connected browsers for a session. */
  broadcastNameUpdate(sessionId: string, name: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.broadcastToBrowsers(session, { type: "session_name_update", name });
    void this.emitPluginEvent(this.createPluginEvent(
      "session.name.updated",
      { sessionId, name },
      { source: "ws-bridge", sessionId, backendType: session.backendType },
    )).then((pluginResult) => {
      if (pluginResult.insights.length > 0) {
        this.broadcastPluginInsights(session, pluginResult.insights);
      }
    });
  }

  private shouldBufferForReplay(msg: BrowserIncomingMessage): msg is ReplayableBrowserIncomingMessage {
    return msg.type !== "session_init"
      && msg.type !== "message_history"
      && msg.type !== "event_replay";
  }

  private isHistoryBackedEvent(msg: ReplayableBrowserIncomingMessage): boolean {
    return msg.type === "assistant"
      || msg.type === "result"
      || msg.type === "user_message"
      || msg.type === "error";
  }

  private sequenceEvent(
    session: Session,
    msg: BrowserIncomingMessage,
  ): BrowserIncomingMessage {
    const seq = session.nextEventSeq++;
    const sequenced = { ...msg, seq };
    if (this.shouldBufferForReplay(msg)) {
      session.eventBuffer.push({ seq, message: msg });
      if (session.eventBuffer.length > WsBridge.EVENT_BUFFER_LIMIT) {
        session.eventBuffer.splice(0, session.eventBuffer.length - WsBridge.EVENT_BUFFER_LIMIT);
      }
      this.persistSession(session);
    }
    return sequenced;
  }

  private broadcastToBrowsers(session: Session, msg: BrowserIncomingMessage) {
    // Debug: warn when assistant messages are broadcast to 0 browsers (they may be lost)
    if (session.browserSockets.size === 0 && (msg.type === "assistant" || msg.type === "stream_event" || msg.type === "result")) {
      console.log(`[ws-bridge] ⚠ Broadcasting ${msg.type} to 0 browsers for session ${session.id} (stored in history: ${msg.type === "assistant" || msg.type === "result"})`);
    }
    const json = JSON.stringify(this.sequenceEvent(session, msg));
    for (const ws of session.browserSockets) {
      try {
        ws.send(json);
      } catch {
        session.browserSockets.delete(ws);
      }
    }
  }

  private sendToBrowser(ws: ServerWebSocket<SocketData>, msg: BrowserIncomingMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket will be cleaned up on close
    }
  }
}
