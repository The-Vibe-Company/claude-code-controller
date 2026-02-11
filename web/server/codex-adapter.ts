/**
 * Codex App-Server Adapter
 *
 * Translates between the Codex app-server JSON-RPC protocol (stdin/stdout)
 * and the Vibe Companion's BrowserIncomingMessage/BrowserOutgoingMessage types.
 *
 * This allows the browser to be completely unaware of which backend is running —
 * it sees the same message types regardless of whether Claude Code or Codex is
 * the backend.
 */

import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  SessionState,
  PermissionRequest,
  CLIResultMessage,
} from "./session-types.js";

// ─── Codex JSON-RPC Types ─────────────────────────────────────────────────────

interface JsonRpcRequest {
  method: string;
  id: number;
  params: Record<string, unknown>;
}

interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// Codex item types
interface CodexItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

/** Safely extract a string kind from a Codex file change entry.
 *  Codex may send kind as a string ("create") or as an object ({ type: "modify" }). */
function safeKind(kind: unknown): string {
  if (typeof kind === "string") return kind;
  if (kind && typeof kind === "object" && "type" in kind) {
    const t = (kind as Record<string, unknown>).type;
    if (typeof t === "string") return t;
  }
  return "modify";
}

interface CodexAgentMessageItem extends CodexItem {
  type: "agentMessage";
  text?: string;
}

interface CodexCommandExecutionItem extends CodexItem {
  type: "commandExecution";
  command: string | string[];
  cwd?: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  exitCode?: number;
  durationMs?: number;
}

interface CodexFileChangeItem extends CodexItem {
  type: "fileChange";
  changes?: Array<{ path: string; kind: unknown; diff?: string }>;
  status: "inProgress" | "completed" | "failed" | "declined";
}

interface CodexMcpToolCallItem extends CodexItem {
  type: "mcpToolCall";
  server: string;
  tool: string;
  status: "inProgress" | "completed" | "failed";
  arguments?: Record<string, unknown>;
  result?: string;
  error?: string;
}

interface CodexWebSearchItem extends CodexItem {
  type: "webSearch";
  query?: string;
  action?: { type: string; url?: string; pattern?: string };
}

interface CodexReasoningItem extends CodexItem {
  type: "reasoning";
  summary?: string;
  content?: string;
}

interface CodexContextCompactionItem extends CodexItem {
  type: "contextCompaction";
}

// ─── Adapter Options ──────────────────────────────────────────────────────────

export interface CodexAdapterOptions {
  model?: string;
  cwd?: string;
  approvalMode?: string;
  sandbox?: "workspace-write" | "danger-full-access";
  /** If provided, resume an existing thread instead of starting a new one. */
  threadId?: string;
}

// ─── JSON-RPC Transport ───────────────────────────────────────────────────────

class JsonRpcTransport {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private notificationHandler: ((method: string, params: Record<string, unknown>) => void) | null = null;
  private requestHandler: ((method: string, id: number, params: Record<string, unknown>) => void) | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private connected = true;
  private buffer = "";

  constructor(
    stdin: WritableStream<Uint8Array> | { write(data: Uint8Array): number },
    stdout: ReadableStream<Uint8Array>,
  ) {
    // Handle both Bun subprocess stdin types
    let writable: WritableStream<Uint8Array>;
    if ("write" in stdin && typeof stdin.write === "function") {
      // Bun's subprocess stdin has a .write() method directly
      writable = new WritableStream({
        write(chunk) {
          (stdin as { write(data: Uint8Array): number }).write(chunk);
        },
      });
    } else {
      writable = stdin as WritableStream<Uint8Array>;
    }
    // Acquire writer once and hold it — avoids "WritableStream is locked" race
    // when concurrent async calls (e.g. rateLimits + turn/start) overlap.
    this.writer = writable.getWriter();

    this.readStdout(stdout);
  }

  private async readStdout(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch (err) {
      console.error("[codex-adapter] stdout reader error:", err);
    } finally {
      this.connected = false;
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        console.warn("[codex-adapter] Failed to parse JSON-RPC:", trimmed.substring(0, 200));
        continue;
      }

      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if ("id" in msg && msg.id !== undefined) {
      if ("method" in msg && msg.method) {
        // This is a request FROM the server (e.g., approval request)
        this.requestHandler?.(msg.method, msg.id as number, (msg as JsonRpcRequest).params || {});
      } else {
        // This is a response to one of our requests
        const pending = this.pending.get(msg.id as number);
        if (pending) {
          this.pending.delete(msg.id as number);
          const resp = msg as JsonRpcResponse;
          if (resp.error) {
            pending.reject(new Error(resp.error.message));
          } else {
            pending.resolve(resp.result);
          }
        }
      }
    } else if ("method" in msg) {
      // Notification (no id)
      this.notificationHandler?.(msg.method, (msg as JsonRpcNotification).params || {});
    }
  }

  /** Send a request and wait for the matching response. */
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    const request = JSON.stringify({ method, id, params });
    await this.writeRaw(request + "\n");
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  /** Send a notification (no response expected). */
  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const notification = JSON.stringify({ method, params });
    await this.writeRaw(notification + "\n");
  }

  /** Respond to a request from the server (e.g., approval). */
  async respond(id: number, result: unknown): Promise<void> {
    const response = JSON.stringify({ id, result });
    await this.writeRaw(response + "\n");
  }

  /** Register handler for server-initiated notifications. */
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  /** Register handler for server-initiated requests (need a response). */
  onRequest(handler: (method: string, id: number, params: Record<string, unknown>) => void): void {
    this.requestHandler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async writeRaw(data: string): Promise<void> {
    await this.writer.write(new TextEncoder().encode(data));
  }
}

// ─── Codex Adapter ────────────────────────────────────────────────────────────

export class CodexAdapter {
  private transport: JsonRpcTransport;
  private proc: Subprocess;
  private sessionId: string;
  private options: CodexAdapterOptions;

  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: { cliSessionId?: string; model?: string; cwd?: string }) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private initErrorCb: ((error: string) => void) | null = null;

  // State
  private threadId: string | null = null;
  private currentTurnId: string | null = null;
  private connected = false;
  private initialized = false;

  // Streaming accumulator for agent messages
  private streamingText = "";
  private streamingItemId: string | null = null;

  // Track message counter for synthesized IDs
  private msgCounter = 0;

  // Accumulate reasoning text by item ID so we can emit final thinking blocks.
  private reasoningTextByItemId = new Map<string, string>();

  // Track which item IDs we have already emitted a tool_use block for.
  // When Codex auto-approves (approvalPolicy "never"), it may skip item/started
  // and only send item/completed — we need to emit tool_use before tool_result.
  private emittedToolUseIds = new Set<string>();

  // Queue messages received before initialization completes
  private pendingOutgoing: BrowserOutgoingMessage[] = [];

  // Pending approval requests (Codex sends these as JSON-RPC requests with an id)
  private pendingApprovals = new Map<string, number>(); // request_id -> JSON-RPC id

  // Track request types that need different response formats
  private pendingUserInputQuestionIds = new Map<string, string[]>(); // request_id -> ordered Codex question IDs
  private pendingReviewDecisions = new Set<string>(); // request_ids that need ReviewDecision format

  // Codex account rate limits (fetched after init, updated via notification)
  private _rateLimits: {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  } | null = null;

  constructor(proc: Subprocess, sessionId: string, options: CodexAdapterOptions = {}) {
    this.proc = proc;
    this.sessionId = sessionId;
    this.options = options;

    const stdout = proc.stdout;
    const stdin = proc.stdin;
    if (!stdout || !stdin || typeof stdout === "number" || typeof stdin === "number") {
      throw new Error("Codex process must have stdio pipes");
    }

    this.transport = new JsonRpcTransport(
      stdin as WritableStream<Uint8Array> | { write(data: Uint8Array): number },
      stdout as ReadableStream<Uint8Array>,
    );
    this.transport.onNotification((method, params) => this.handleNotification(method, params));
    this.transport.onRequest((method, id, params) => this.handleRequest(method, id, params));

    // Monitor process exit
    proc.exited.then(() => {
      this.connected = false;
      this.disconnectCb?.();
    });

    // Start initialization
    this.initialize();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  getRateLimits() {
    return this._rateLimits;
  }

  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean {
    // Queue messages if not yet initialized (init is async)
    if (!this.initialized || !this.threadId) {
      if (msg.type === "user_message" || msg.type === "permission_response") {
        console.log(`[codex-adapter] Queuing ${msg.type} — adapter not yet initialized`);
        this.pendingOutgoing.push(msg);
        return true; // accepted, will be sent after init
      }
      // Non-queueable messages are dropped if not connected
      if (!this.connected) return false;
    }

    return this.dispatchOutgoing(msg);
  }

  private dispatchOutgoing(msg: BrowserOutgoingMessage): boolean {
    switch (msg.type) {
      case "user_message":
        this.handleOutgoingUserMessage(msg);
        return true;
      case "permission_response":
        this.handleOutgoingPermissionResponse(msg);
        return true;
      case "interrupt":
        this.handleOutgoingInterrupt();
        return true;
      case "set_model":
        console.warn("[codex-adapter] Runtime model switching not supported by Codex");
        return false;
      case "set_permission_mode":
        console.warn("[codex-adapter] Runtime permission mode switching not supported by Codex");
        return false;
      default:
        return false;
    }
  }

  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
    this.browserMessageCb = cb;
  }

  onSessionMeta(cb: (meta: { cliSessionId?: string; model?: string; cwd?: string }) => void): void {
    this.sessionMetaCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  onInitError(cb: (error: string) => void): void {
    this.initErrorCb = cb;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      this.proc.kill("SIGTERM");
      await Promise.race([
        this.proc.exited,
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch {}
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  // ── Initialization ──────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    try {
      // Step 1: Send initialize request
      const result = await this.transport.call("initialize", {
        clientInfo: {
          name: "vibe-companion",
          title: "The Vibe Companion",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: false,
        },
      }) as Record<string, unknown>;

      // Step 2: Send initialized notification
      await this.transport.notify("initialized", {});

      this.connected = true;
      this.initialized = true;

      // Step 3: Start or resume a thread
      if (this.options.threadId) {
        // Resume an existing thread
        const resumeResult = await this.transport.call("thread/resume", {
          threadId: this.options.threadId,
          model: this.options.model,
          cwd: this.options.cwd,
          approvalPolicy: this.mapApprovalPolicy(this.options.approvalMode),
          sandbox: this.options.sandbox || "workspace-write",
        }) as { thread: { id: string } };
        this.threadId = resumeResult.thread.id;
      } else {
        // Start a new thread
        const threadResult = await this.transport.call("thread/start", {
          model: this.options.model,
          cwd: this.options.cwd,
          approvalPolicy: this.mapApprovalPolicy(this.options.approvalMode),
          sandbox: this.options.sandbox || "workspace-write",
        }) as { thread: { id: string } };
        this.threadId = threadResult.thread.id;
      }

      // Notify session metadata
      this.sessionMetaCb?.({
        cliSessionId: this.threadId,
        model: this.options.model,
        cwd: this.options.cwd,
      });

      // Send session_init to browser
      const state: SessionState = {
        session_id: this.sessionId,
        backend_type: "codex",
        model: this.options.model || "",
        cwd: this.options.cwd || "",
        tools: [],
        permissionMode: this.options.approvalMode || "suggest",
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

      this.emit({ type: "session_init", session: state });

      // Fetch initial rate limits (non-blocking — don't fail init if this errors)
      this.transport.call("account/rateLimits/read", {}).then((result) => {
        this.updateRateLimits(result as Record<string, unknown>);
      }).catch(() => { /* best-effort */ });

      // Flush any messages that were queued during initialization
      if (this.pendingOutgoing.length > 0) {
        console.log(`[codex-adapter] Flushing ${this.pendingOutgoing.length} queued message(s)`);
        const queued = this.pendingOutgoing.splice(0);
        for (const msg of queued) {
          this.dispatchOutgoing(msg);
        }
      }
    } catch (err) {
      const errorMsg = `Codex initialization failed: ${err}`;
      console.error(`[codex-adapter] ${errorMsg}`);
      this.emit({ type: "error", message: errorMsg });
      this.connected = false;
      this.initErrorCb?.(errorMsg);
    }
  }

  // ── Outgoing message handlers ───────────────────────────────────────────

  private async handleOutgoingUserMessage(
    msg: { type: "user_message"; content: string; images?: { media_type: string; data: string }[] },
  ): Promise<void> {
    if (!this.threadId) {
      this.emit({ type: "error", message: "No Codex thread started yet" });
      return;
    }

    const input: Array<{ type: string; text?: string; url?: string }> = [];

    // Add images if present
    if (msg.images?.length) {
      for (const img of msg.images) {
        input.push({
          type: "image",
          url: `data:${img.media_type};base64,${img.data}`,
        });
      }
    }

    // Add text
    input.push({ type: "text", text: msg.content });

    try {
      const result = await this.transport.call("turn/start", {
        threadId: this.threadId,
        input,
        cwd: this.options.cwd,
      }) as { turn: { id: string } };

      this.currentTurnId = result.turn.id;
    } catch (err) {
      this.emit({ type: "error", message: `Failed to start turn: ${err}` });
    }
  }

  private async handleOutgoingPermissionResponse(
    msg: { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown> },
  ): Promise<void> {
    const jsonRpcId = this.pendingApprovals.get(msg.request_id);
    if (jsonRpcId === undefined) {
      console.warn(`[codex-adapter] No pending approval for request_id=${msg.request_id}`);
      return;
    }

    this.pendingApprovals.delete(msg.request_id);

    // User input requests (item/tool/requestUserInput) need ToolRequestUserInputResponse
    const questionIds = this.pendingUserInputQuestionIds.get(msg.request_id);
    if (questionIds) {
      this.pendingUserInputQuestionIds.delete(msg.request_id);

      if (msg.behavior === "deny") {
        // Respond with empty answers on deny
        await this.transport.respond(jsonRpcId, { answers: {} });
        return;
      }

      // Convert browser answers (keyed by index "0","1",...) to Codex format (keyed by question ID)
      const browserAnswers = msg.updated_input?.answers as Record<string, string> || {};
      const codexAnswers: Record<string, { answers: string[] }> = {};
      for (let i = 0; i < questionIds.length; i++) {
        const answer = browserAnswers[String(i)];
        if (answer !== undefined) {
          codexAnswers[questionIds[i]] = { answers: [answer] };
        }
      }

      await this.transport.respond(jsonRpcId, { answers: codexAnswers });
      return;
    }

    // Review decisions (applyPatchApproval / execCommandApproval) need ReviewDecision
    if (this.pendingReviewDecisions.has(msg.request_id)) {
      this.pendingReviewDecisions.delete(msg.request_id);
      const decision = msg.behavior === "allow" ? "approved" : "denied";
      await this.transport.respond(jsonRpcId, { decision });
      return;
    }

    // Standard item/*/requestApproval — uses accept/decline
    const decision = msg.behavior === "allow" ? "accept" : "decline";
    await this.transport.respond(jsonRpcId, { decision });
  }

  private async handleOutgoingInterrupt(): Promise<void> {
    if (!this.threadId || !this.currentTurnId) return;

    try {
      await this.transport.call("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.currentTurnId,
      });
    } catch (err) {
      console.warn("[codex-adapter] Interrupt failed:", err);
    }
  }

  // ── Incoming notification handlers ──────────────────────────────────────

  private handleNotification(method: string, params: Record<string, unknown>): void {
    // Debug: log all significant notifications to understand Codex event flow
    if (method.startsWith("item/") || method.startsWith("turn/") || method.startsWith("thread/")) {
      const item = params.item as { type?: string; id?: string } | undefined;
      console.log(`[codex-adapter] ← ${method}${item ? ` type=${item.type} id=${item.id}` : ""}${!item && Object.keys(params).length > 0 ? ` keys=[${Object.keys(params).join(",")}]` : ""}`);
    }

    try {
    switch (method) {
      case "item/started":
        this.handleItemStarted(params);
        break;
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(params);
        break;
      case "item/commandExecution/outputDelta":
        // Streaming command output (stdout/stderr). Not critical for rendering
        // since item/completed provides the full output, but log for debugging.
        break;
      case "item/fileChange/outputDelta":
        // Streaming file change output. Same as above.
        break;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/summaryPartAdded":
        this.handleReasoningDelta(params);
        break;
      case "item/mcpToolCall/progress":
        // MCP tool call progress — could map to tool_progress.
        break;
      case "item/plan/delta":
        // Plan updates — could display in future.
        break;
      case "item/updated":
        this.handleItemUpdated(params);
        break;
      case "item/completed":
        this.handleItemCompleted(params);
        break;
      case "rawResponseItem/completed":
        // Raw model response — internal, not needed for UI.
        break;
      case "turn/started":
        // Turn started, nothing to emit
        break;
      case "turn/completed":
        this.handleTurnCompleted(params);
        break;
      case "turn/plan/updated":
        // Could emit as tool_progress or similar
        break;
      case "turn/diff/updated":
        // Could show diff, but not needed for MVP
        break;
      case "thread/started":
        // Thread started after init — nothing to emit.
        break;
      case "thread/tokenUsage/updated":
        this.handleTokenUsageUpdated(params);
        break;
      case "account/updated":
      case "account/login/completed":
        // Auth events
        break;
      case "account/rateLimits/updated":
        this.updateRateLimits(params);
        break;
      default:
        // Unknown notification, log for debugging
        if (!method.startsWith("account/") && !method.startsWith("codex/event/")) {
          console.log(`[codex-adapter] Unhandled notification: ${method}`);
        }
        break;
    }
    } catch (err) {
      console.error(`[codex-adapter] Error handling notification ${method}:`, err);
    }
  }

  // ── Incoming request handlers (approval requests) ───────────────────────

  private handleRequest(method: string, id: number, params: Record<string, unknown>): void {
    try {
      switch (method) {
        case "item/commandExecution/requestApproval":
          this.handleCommandApproval(id, params);
          break;
        case "item/fileChange/requestApproval":
          this.handleFileChangeApproval(id, params);
          break;
        case "item/mcpToolCall/requestApproval":
          this.handleMcpToolCallApproval(id, params);
          break;
        case "item/tool/call":
          this.handleDynamicToolCall(id, params);
          break;
        case "item/tool/requestUserInput":
          this.handleUserInputRequest(id, params);
          break;
        case "applyPatchApproval":
          this.handleApplyPatchApproval(id, params);
          break;
        case "execCommandApproval":
          this.handleExecCommandApproval(id, params);
          break;
        case "account/chatgptAuthTokens/refresh":
          console.warn("[codex-adapter] Auth token refresh not supported");
          this.transport.respond(id, { error: "not supported" });
          break;
        default:
          console.log(`[codex-adapter] Unhandled request: ${method}`);
          // Auto-accept unknown requests
          this.transport.respond(id, { decision: "accept" });
          break;
      }
    } catch (err) {
      console.error(`[codex-adapter] Error handling request ${method}:`, err);
    }
  }

  private handleCommandApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-approval-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    const command = params.command as string | string[] | undefined;
    const commandStr = params.parsedCmd as string || (Array.isArray(command) ? command.join(" ") : command) || "";

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Bash",
      input: {
        command: commandStr,
        cwd: params.cwd as string || this.options.cwd || "",
      },
      description: params.reason as string || `Execute: ${commandStr}`,
      tool_use_id: params.itemId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleFileChangeApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-approval-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    // Extract file paths from changes array if available
    const changes = params.changes as Array<{ path?: string; kind?: string }> | undefined;
    const filePaths = changes?.map((c) => c.path).filter(Boolean) || [];
    const fileList = filePaths.length > 0 ? filePaths.join(", ") : undefined;

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Edit",
      input: {
        description: params.reason as string || "File changes pending approval",
        ...(filePaths.length > 0 && { file_paths: filePaths }),
        ...(changes && { changes }),
      },
      description: params.reason as string || (fileList ? `Codex wants to modify: ${fileList}` : "Codex wants to modify files"),
      tool_use_id: params.itemId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleMcpToolCallApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-approval-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    const server = params.server as string || "unknown";
    const tool = params.tool as string || "unknown";
    const args = params.arguments as Record<string, unknown> || {};

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: `mcp:${server}:${tool}`,
      input: args,
      description: params.reason as string || `MCP tool call: ${server}/${tool}`,
      tool_use_id: params.itemId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleDynamicToolCall(jsonRpcId: number, params: Record<string, unknown>): void {
    const callId = params.callId as string || `dynamic-${randomUUID()}`;
    const toolName = params.tool as string || "unknown_dynamic_tool";
    const toolArgs = params.arguments as Record<string, unknown> || {};

    console.log(`[codex-adapter] Dynamic tool call received: ${toolName} (callId=${callId})`);

    // Emit tool_use + tool_result to browser so the user sees what was attempted
    this.emitToolUseTracked(callId, `dynamic:${toolName}`, toolArgs);
    this.emitToolResult(
      callId,
      `Dynamic tool "${toolName}" is not supported by this client.`,
      true,
    );

    // Respond to Codex with a valid DynamicToolCallResponse
    this.transport.respond(jsonRpcId, {
      contentItems: [{ type: "inputText", text: "Dynamic tool execution is not supported by this client" }],
      success: false,
    });
  }

  private handleUserInputRequest(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-userinput-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    const questions = params.questions as Array<{
      id: string; header: string; question: string;
      isOther: boolean; isSecret: boolean;
      options: Array<{ label: string; description: string }> | null;
    }> || [];

    // Store question IDs so we can map browser indices back to Codex IDs in the response
    this.pendingUserInputQuestionIds.set(requestId, questions.map((q) => q.id));

    // Convert to our AskUserQuestion format (matches AskUserQuestionDisplay component)
    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "AskUserQuestion",
      input: {
        questions: questions.map((q) => ({
          header: q.header,
          question: q.question,
          options: q.options?.map((o) => ({ label: o.label, description: o.description })) || [],
        })),
      },
      description: questions[0]?.question || "User input requested",
      tool_use_id: params.itemId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleApplyPatchApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-patch-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);
    this.pendingReviewDecisions.add(requestId);

    const fileChanges = params.fileChanges as Record<string, unknown> || {};
    const filePaths = Object.keys(fileChanges);
    const reason = params.reason as string | null;

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Edit",
      input: {
        file_paths: filePaths,
        ...(reason && { reason }),
      },
      description: reason || (filePaths.length > 0
        ? `Codex wants to modify: ${filePaths.join(", ")}`
        : "Codex wants to modify files"),
      tool_use_id: params.callId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleExecCommandApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-exec-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);
    this.pendingReviewDecisions.add(requestId);

    const command = params.command as string[] || [];
    const commandStr = command.join(" ");
    const cwd = params.cwd as string || this.options.cwd || "";
    const reason = params.reason as string | null;

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Bash",
      input: {
        command: commandStr,
        cwd,
      },
      description: reason || `Execute: ${commandStr}`,
      tool_use_id: params.callId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  // ── Item event handlers ─────────────────────────────────────────────────

  private handleItemStarted(params: Record<string, unknown>): void {
    const item = params.item as CodexItem;
    if (!item) return;

    switch (item.type) {
      case "agentMessage":
        // Start streaming accumulation
        this.streamingItemId = item.id;
        this.streamingText = "";
        // Emit message_start stream event so the browser knows streaming began
        this.emit({
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              id: `codex-msg-${++this.msgCounter}`,
              type: "message",
              role: "assistant",
              model: this.options.model || "",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
          },
          parent_tool_use_id: null,
        });
        // Also emit content_block_start
        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          parent_tool_use_id: null,
        });
        break;

      case "commandExecution": {
        const cmd = item as CodexCommandExecutionItem;
        const commandStr = Array.isArray(cmd.command) ? cmd.command.join(" ") : (cmd.command || "");
        this.emitToolUseStart(item.id, "Bash", { command: commandStr });
        break;
      }

      case "fileChange": {
        const fc = item as CodexFileChangeItem;
        const changes = fc.changes || [];
        const firstChange = changes[0];
        const toolName = safeKind(firstChange?.kind) === "create" ? "Write" : "Edit";
        const toolInput = {
          file_path: firstChange?.path || "",
          changes: changes.map((c) => ({ path: c.path, kind: safeKind(c.kind) })),
        };
        this.emitToolUseStart(item.id, toolName, toolInput);
        break;
      }

      case "mcpToolCall": {
        const mcp = item as CodexMcpToolCallItem;
        this.emitToolUseStart(item.id, `mcp:${mcp.server}:${mcp.tool}`, mcp.arguments || {});
        break;
      }

      case "webSearch": {
        const ws = item as CodexWebSearchItem;
        this.emitToolUseStart(item.id, "WebSearch", { query: ws.query || "" });
        break;
      }

      case "reasoning": {
        const r = item as CodexReasoningItem;
        this.reasoningTextByItemId.set(item.id, r.summary || r.content || "");
        // Emit as thinking content block
        if (r.summary || r.content) {
          this.emit({
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: r.summary || r.content || "" },
            },
            parent_tool_use_id: null,
          });
        }
        break;
      }

      case "contextCompaction":
        this.emit({ type: "status_change", status: "compacting" });
        break;

      default:
        // userMessage is an echo of browser input and not needed in UI.
        if (item.type !== "userMessage") {
          console.log(`[codex-adapter] Unhandled item/started type: ${item.type}`, JSON.stringify(item).substring(0, 300));
        }
        break;
    }
  }

  private handleReasoningDelta(params: Record<string, unknown>): void {
    const itemId = params.itemId as string | undefined;
    if (!itemId) return;

    if (!this.reasoningTextByItemId.has(itemId)) {
      this.reasoningTextByItemId.set(itemId, "");
    }

    const delta = params.delta as string | undefined;
    if (delta) {
      const current = this.reasoningTextByItemId.get(itemId) || "";
      this.reasoningTextByItemId.set(itemId, current + delta);
    }
  }

  private handleAgentMessageDelta(params: Record<string, unknown>): void {
    const delta = params.delta as string;
    if (!delta) return;

    this.streamingText += delta;

    // Emit as content_block_delta (matches Claude's streaming format)
    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: delta },
      },
      parent_tool_use_id: null,
    });
  }

  private handleItemUpdated(params: Record<string, unknown>): void {
    // item/updated is a general update — currently we handle streaming via the specific delta events
    // Could handle status updates for command_execution / file_change items here
  }

  private handleItemCompleted(params: Record<string, unknown>): void {
    const item = params.item as CodexItem;
    if (!item) return;

    switch (item.type) {
      case "agentMessage": {
        const agentMsg = item as CodexAgentMessageItem;
        const text = agentMsg.text || this.streamingText;

        // Emit message_stop for streaming
        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_stop",
            index: 0,
          },
          parent_tool_use_id: null,
        });
        this.emit({
          type: "stream_event",
          event: {
            type: "message_delta",
            delta: { stop_reason: null }, // null, not "end_turn" — the turn may continue with tool calls
            usage: { output_tokens: 0 },
          },
          parent_tool_use_id: null,
        });

        // Emit the full assistant message
        this.emit({
          type: "assistant",
          message: {
            id: `codex-msg-${++this.msgCounter}`,
            type: "message",
            role: "assistant",
            model: this.options.model || "",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
        });

        // Reset streaming state
        this.streamingText = "";
        this.streamingItemId = null;
        break;
      }

      case "commandExecution": {
        const cmd = item as CodexCommandExecutionItem;
        const commandStr = Array.isArray(cmd.command) ? cmd.command.join(" ") : (cmd.command || "");
        // Ensure tool_use was emitted (may be skipped when auto-approved)
        this.ensureToolUseEmitted(item.id, "Bash", { command: commandStr });
        // Emit tool result
        const output = (item as Record<string, unknown>).stdout as string || "";
        const stderr = (item as Record<string, unknown>).stderr as string || "";
        const combinedOutput = [output, stderr].filter(Boolean).join("\n").trim();
        const exitCode = typeof cmd.exitCode === "number" ? cmd.exitCode : 0;
        const failed = cmd.status === "failed" || cmd.status === "declined" || exitCode !== 0;

        // Always emit tool_result so the browser shows a complete tool block.
        if (!combinedOutput && !failed) {
          this.emitToolResult(item.id, "Command completed successfully.", false);
          break;
        }

        let resultText = combinedOutput;
        if (!resultText) {
          resultText = `Exit code: ${exitCode}`;
        } else if (exitCode !== 0) {
          resultText = `${resultText}\nExit code: ${exitCode}`;
        }

        this.emitToolResult(item.id, resultText, failed);
        break;
      }

      case "fileChange": {
        const fc = item as CodexFileChangeItem;
        const changes = fc.changes || [];
        const firstChange = changes[0];
        const toolName = safeKind(firstChange?.kind) === "create" ? "Write" : "Edit";
        // Ensure tool_use was emitted
        this.ensureToolUseEmitted(item.id, toolName, {
          file_path: firstChange?.path || "",
          changes: changes.map((c) => ({ path: c.path, kind: safeKind(c.kind) })),
        });
        const summary = changes.map((c) => `${safeKind(c.kind)}: ${c.path}`).join("\n");
        this.emitToolResult(item.id, summary || "File changes applied", fc.status === "failed");
        break;
      }

      case "mcpToolCall": {
        const mcp = item as CodexMcpToolCallItem;
        // Ensure tool_use was emitted
        this.ensureToolUseEmitted(item.id, `mcp:${mcp.server}:${mcp.tool}`, mcp.arguments || {});
        this.emitToolResult(item.id, mcp.result || mcp.error || "MCP tool call completed", mcp.status === "failed");
        break;
      }

      case "webSearch": {
        const ws = item as CodexWebSearchItem;
        // Ensure tool_use was emitted
        this.ensureToolUseEmitted(item.id, "WebSearch", { query: ws.query || "" });
        this.emitToolResult(item.id, ws.action?.url || ws.query || "Web search completed", false);
        break;
      }

      case "reasoning": {
        const r = item as CodexReasoningItem;
        const thinkingText = (
          this.reasoningTextByItemId.get(item.id)
          || r.summary
          || r.content
          || ""
        ).trim();

        if (thinkingText) {
          this.emit({
            type: "assistant",
            message: {
              id: `codex-msg-${++this.msgCounter}`,
              type: "message",
              role: "assistant",
              model: this.options.model || "",
              content: [{ type: "thinking", thinking: thinkingText }],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
            parent_tool_use_id: null,
          });
        }

        this.reasoningTextByItemId.delete(item.id);

        // Close the thinking content block that was opened in handleItemStarted
        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_stop",
            index: 0,
          },
          parent_tool_use_id: null,
        });
        break;
      }

      case "contextCompaction":
        this.emit({ type: "status_change", status: null });
        break;

      default:
        if (item.type !== "userMessage") {
          console.log(`[codex-adapter] Unhandled item/completed type: ${item.type}`, JSON.stringify(item).substring(0, 300));
        }
        break;
    }
  }

  private handleTurnCompleted(params: Record<string, unknown>): void {
    const turn = params.turn as { id: string; status: string; error?: { message: string } } | undefined;

    // Synthesize a CLIResultMessage-like structure
    const result: CLIResultMessage = {
      type: "result",
      subtype: turn?.status === "completed" ? "success" : "error_during_execution",
      is_error: turn?.status !== "completed",
      result: turn?.error?.message,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      stop_reason: turn?.status || "end_turn",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: randomUUID(),
      session_id: this.sessionId,
    };

    this.emit({ type: "result", data: result });
    this.currentTurnId = null;
  }

  private updateRateLimits(data: Record<string, unknown>): void {
    const rl = data?.rateLimits as Record<string, unknown> | undefined;
    if (!rl) return;
    this._rateLimits = {
      primary: rl.primary as { usedPercent: number; windowDurationMins: number; resetsAt: number } | null,
      secondary: rl.secondary as { usedPercent: number; windowDurationMins: number; resetsAt: number } | null,
    };
  }

  private handleTokenUsageUpdated(params: Record<string, unknown>): void {
    // Codex sends: { threadId, turnId, tokenUsage: {
    //   total: { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens },
    //   last: { ... },
    //   modelContextWindow: 258400
    // }}
    const tokenUsage = params.tokenUsage as Record<string, unknown> | undefined;
    if (!tokenUsage) return;

    const total = tokenUsage.total as Record<string, number> | undefined;
    const contextWindow = tokenUsage.modelContextWindow as number | undefined;

    const updates: Partial<{ total_cost_usd: number; context_used_percent: number }> = {};

    if (total && contextWindow && contextWindow > 0) {
      const used = (total.inputTokens || 0) + (total.outputTokens || 0);
      const pct = Math.round((used / contextWindow) * 100);
      updates.context_used_percent = Math.max(0, Math.min(pct, 100));
    }

    // Codex doesn't seem to provide cost data directly in tokenUsage
    // (no cost field observed), so we skip cost for now.

    if (Object.keys(updates).length > 0) {
      this.emit({
        type: "session_update",
        session: updates,
      });
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private emit(msg: BrowserIncomingMessage): void {
    this.browserMessageCb?.(msg);
  }

  /** Emit an assistant message with a tool_use content block (no tracking). */
  private emitToolUse(toolUseId: string, toolName: string, input: Record<string, unknown>): void {
    console.log(`[codex-adapter] Emitting tool_use: ${toolName} id=${toolUseId}`);
    this.emit({
      type: "assistant",
      message: {
        id: `codex-msg-${++this.msgCounter}`,
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: toolName,
            input,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });
  }

  /** Emit tool_use and track the ID so we don't double-emit. */
  private emitToolUseTracked(toolUseId: string, toolName: string, input: Record<string, unknown>): void {
    this.emittedToolUseIds.add(toolUseId);
    this.emitToolUse(toolUseId, toolName, input);
  }

  /**
   * Emit a tool_use start sequence: stream_event content_block_start + assistant message.
   * This matches Claude Code's streaming pattern and ensures the frontend sees the tool block
   * even during active streaming.
   */
  private emitToolUseStart(toolUseId: string, toolName: string, input: Record<string, unknown>): void {
    // Emit stream event for tool_use start (matches Claude Code pattern)
    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: toolUseId, name: toolName, input: {} },
      },
      parent_tool_use_id: null,
    });
    this.emitToolUseTracked(toolUseId, toolName, input);
  }

  /** Emit tool_use only if item/started was never received for this ID. */
  private ensureToolUseEmitted(toolUseId: string, toolName: string, input: Record<string, unknown>): void {
    if (!this.emittedToolUseIds.has(toolUseId)) {
      console.log(`[codex-adapter] Backfilling tool_use for ${toolName} (id=${toolUseId}) — item/started was missing`);
      this.emitToolUseTracked(toolUseId, toolName, input);
    }
  }

  /** Emit an assistant message with a tool_result content block. */
  private emitToolResult(toolUseId: string, content: unknown, isError: boolean): void {
    const safeContent = typeof content === "string" ? content : JSON.stringify(content);
    this.emit({
      type: "assistant",
      message: {
        id: `codex-msg-${++this.msgCounter}`,
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: safeContent,
            is_error: isError,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });
  }

  private mapApprovalPolicy(mode?: string): string {
    switch (mode) {
      case "bypassPermissions":
        return "never";
      case "plan":
      case "acceptEdits":
      case "default":
      default:
        return "untrusted";
    }
  }
}
