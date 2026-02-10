import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import type {
  CLIMessage,
  CLISystemInitMessage,
  CLIAssistantMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLIToolProgressMessage,
  CLIToolUseSummaryMessage,
  CLIControlRequestMessage,
  CLIAuthStatusMessage,
  BrowserOutgoingMessage,
  BrowserIncomingMessage,
  SessionState,
  PermissionRequest,
} from "./session-types.js";
import type { SessionStore } from "./session-store.js";

// ─── WebSocket data tags ──────────────────────────────────────────────────────

interface CLISocketData {
  kind: "cli";
  sessionId: string;
}

interface BrowserSocketData {
  kind: "browser";
  sessionId: string;
}

export type SocketData = CLISocketData | BrowserSocketData;

// ─── Session ──────────────────────────────────────────────────────────────────

interface Session {
  id: string;
  cliSocket: ServerWebSocket<SocketData> | null;
  browserSockets: Set<ServerWebSocket<SocketData>>;
  state: SessionState;
  pendingPermissions: Map<string, PermissionRequest>;
  messageHistory: BrowserIncomingMessage[];
  /** Messages queued while waiting for CLI to connect */
  pendingMessages: string[];
}

function makeDefaultState(sessionId: string): SessionState {
  return {
    session_id: sessionId,
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
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

export class WsBridge {
  private sessions = new Map<string, Session>();
  private store: SessionStore | null = null;
  private onCLISessionId: ((sessionId: string, cliSessionId: string) => void) | null = null;
  private onCLIRelaunchNeeded: ((sessionId: string) => void) | null = null;

  /** Register a callback for when we learn the CLI's internal session ID. */
  onCLISessionIdReceived(cb: (sessionId: string, cliSessionId: string) => void): void {
    this.onCLISessionId = cb;
  }

  /** Register a callback for when a browser connects but CLI is dead. */
  onCLIRelaunchNeededCallback(cb: (sessionId: string) => void): void {
    this.onCLIRelaunchNeeded = cb;
  }

  /** Attach a persistent store. Call restoreFromDisk() after. */
  setStore(store: SessionStore): void {
    this.store = store;
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
        cliSocket: null,
        browserSockets: new Set(),
        state: p.state,
        pendingPermissions: new Map(p.pendingPermissions || []),
        messageHistory: p.messageHistory || [],
        pendingMessages: p.pendingMessages || [],
      };
      this.sessions.set(p.id, session);
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
    });
  }

  // ── Session management ──────────────────────────────────────────────────

  getOrCreateSession(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        cliSocket: null,
        browserSockets: new Set(),
        state: makeDefaultState(sessionId),
        pendingPermissions: new Map(),
        messageHistory: [],
        pendingMessages: [],
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values()).map((s) => s.state);
  }

  isCliConnected(sessionId: string): boolean {
    return !!this.sessions.get(sessionId)?.cliSocket;
  }

  removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.store?.remove(sessionId);
  }

  /**
   * Close all sockets (CLI + browsers) for a session and remove it.
   */
  closeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Close CLI socket
    if (session.cliSocket) {
      try { session.cliSocket.close(); } catch {}
      session.cliSocket = null;
    }

    // Close all browser sockets
    for (const ws of session.browserSockets) {
      try { ws.close(); } catch {}
    }
    session.browserSockets.clear();

    this.sessions.delete(sessionId);
    this.store?.remove(sessionId);
  }

  // ── CLI WebSocket handlers ──────────────────────────────────────────────

  handleCLIOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    session.cliSocket = ws;
    console.log(`[ws-bridge] CLI connected for session ${sessionId}`);
    this.broadcastToBrowsers(session, { type: "cli_connected" });

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
  }

  // ── Browser WebSocket handlers ──────────────────────────────────────────

  handleBrowserOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    session.browserSockets.add(ws);
    console.log(`[ws-bridge] Browser connected for session ${sessionId} (${session.browserSockets.size} browsers)`);

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

    // Notify if CLI is not connected and request relaunch
    if (!session.cliSocket) {
      this.sendToBrowser(ws, { type: "cli_disconnected" });
      if (this.onCLIRelaunchNeeded) {
        console.log(`[ws-bridge] Browser connected but CLI is dead for session ${sessionId}, requesting relaunch`);
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

    this.routeBrowserMessage(session, msg);
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
        this.handleAssistantMessage(session, msg as CLIAssistantMessage);
        break;

      case "result":
        this.handleResultMessage(session, msg as CLIResultMessage);
        break;

      case "stream_event":
        this.handleStreamEvent(session, msg as CLIStreamEventMessage);
        break;

      case "control_request":
        this.handleControlRequest(session, msg as CLIControlRequestMessage);
        break;

      case "tool_progress":
        this.handleToolProgress(session, msg as CLIToolProgressMessage);
        break;

      case "tool_use_summary":
        this.handleToolUseSummary(session, msg as CLIToolUseSummaryMessage);
        break;

      case "auth_status":
        this.handleAuthStatus(session, msg as CLIAuthStatusMessage);
        break;

      case "keep_alive":
        // Silently consume keepalives
        break;

      default:
        // Forward unknown messages as-is for debugging
        break;
    }
  }

  private handleSystemMessage(session: Session, msg: CLIMessage) {
    if (msg.type !== "system") return;

    const subtype = (msg as { subtype?: string }).subtype;

    if (subtype === "init") {
      const init = msg as unknown as CLISystemInitMessage;
      // Keep the launcher-assigned session_id as the canonical ID.
      // The CLI may report its own internal session_id which differs
      // from the launcher UUID, causing duplicate entries in the sidebar.

      // Store the CLI's internal session_id so we can --resume on relaunch
      if (init.session_id && this.onCLISessionId) {
        this.onCLISessionId(session.id, init.session_id);
      }

      session.state.model = init.model;
      session.state.cwd = init.cwd;
      session.state.tools = init.tools;
      session.state.permissionMode = init.permissionMode;
      session.state.claude_code_version = init.claude_code_version;
      session.state.mcp_servers = init.mcp_servers;
      session.state.agents = init.agents ?? [];
      session.state.slash_commands = init.slash_commands ?? [];
      session.state.skills = init.skills ?? [];

      // Resolve git branch from session cwd
      if (session.state.cwd) {
        try {
          session.state.git_branch = execSync("git rev-parse --abbrev-ref HEAD", {
            cwd: session.state.cwd,
            encoding: "utf-8",
            timeout: 3000,
          }).trim();
        } catch {
          // Not a git repo or git not available
        }
      }

      this.broadcastToBrowsers(session, {
        type: "session_init",
        session: session.state,
      });
      this.persistSession(session);
    } else if (subtype === "status") {
      const status = (msg as { status?: "compacting" | null }).status;
      session.state.is_compacting = status === "compacting";

      const permMode = (msg as { permissionMode?: string }).permissionMode;
      if (permMode) {
        session.state.permissionMode = permMode;
      }

      this.broadcastToBrowsers(session, {
        type: "status_change",
        status: status ?? null,
      });
    }
    // Other system subtypes (compact_boundary, task_notification, etc.) can be forwarded as needed
  }

  private handleAssistantMessage(session: Session, msg: CLIAssistantMessage) {
    const browserMsg: BrowserIncomingMessage = {
      type: "assistant",
      message: msg.message,
      parent_tool_use_id: msg.parent_tool_use_id,
    };
    session.messageHistory.push(browserMsg);
    this.broadcastToBrowsers(session, browserMsg);
    this.persistSession(session);
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
          session.state.context_used_percent = Math.round(
            ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100
          );
        }
      }
    }

    const browserMsg: BrowserIncomingMessage = {
      type: "result",
      data: msg,
    };
    session.messageHistory.push(browserMsg);
    this.broadcastToBrowsers(session, browserMsg);
    this.persistSession(session);
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
      // Auto-approve if in dontAsk mode
      if (session.state.permissionMode === "dontAsk") {
        const ndjson = JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: msg.request_id,
            response: {
              behavior: "allow",
              updatedInput: msg.request.input ?? {},
            },
          },
        });
        this.sendToCLI(session, ndjson);
        return;
      }

      const perm: PermissionRequest = {
        request_id: msg.request_id,
        tool_name: msg.request.tool_name,
        input: msg.request.input,
        permission_suggestions: msg.request.permission_suggestions as PermissionRequest["permission_suggestions"],
        description: msg.request.description,
        tool_use_id: msg.request.tool_use_id,
        agent_id: msg.request.agent_id,
        timestamp: Date.now(),
      };
      session.pendingPermissions.set(msg.request_id, perm);

      this.broadcastToBrowsers(session, {
        type: "permission_request",
        request: perm,
      });
      this.persistSession(session);
    }
  }

  private handleToolProgress(session: Session, msg: CLIToolProgressMessage) {
    this.broadcastToBrowsers(session, {
      type: "tool_progress",
      tool_use_id: msg.tool_use_id,
      tool_name: msg.tool_name,
      elapsed_time_seconds: msg.elapsed_time_seconds,
    });
  }

  private handleToolUseSummary(session: Session, msg: CLIToolUseSummaryMessage) {
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

  private routeBrowserMessage(session: Session, msg: BrowserOutgoingMessage) {
    switch (msg.type) {
      case "user_message":
        this.handleUserMessage(session, msg);
        break;

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
    }
  }

  private handleUserMessage(
    session: Session,
    msg: { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[] }
  ) {
    // Store user message in history for replay (text-only for replay)
    session.messageHistory.push({
      type: "user_message",
      content: msg.content,
      timestamp: Date.now(),
    });

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
    this.persistSession(session);
  }

  private handlePermissionResponse(
    session: Session,
    msg: { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown>; updated_permissions?: unknown[]; message?: string }
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

  private broadcastToBrowsers(session: Session, msg: BrowserIncomingMessage) {
    const json = JSON.stringify(msg);
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
