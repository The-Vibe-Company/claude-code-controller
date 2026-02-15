// Types for the WebSocket bridge between Claude Code CLI and the browser

// ─── CLI Message Types (NDJSON from Claude Code CLI) ──────────────────────────

export interface CLISystemInitMessage {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: string;
  apiKeySource: string;
  claude_code_version: string;
  slash_commands: string[];
  agents?: string[];
  skills?: string[];
  output_style: string;
  uuid: string;
}

export interface CLISystemStatusMessage {
  type: "system";
  subtype: "status";
  status: "compacting" | null;
  permissionMode?: string;
  uuid: string;
  session_id: string;
}

export interface CLIAssistantMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: string;
    content: ContentBlock[];
    stop_reason: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
  parent_tool_use_id: string | null;
  error?: string;
  uuid: string;
  session_id: string;
}

export interface CLIResultMessage {
  type: "result";
  subtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries";
  is_error: boolean;
  result?: string;
  errors?: string[];
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    contextWindow: number;
    maxOutputTokens: number;
    costUSD: number;
  }>;
  total_lines_added?: number;
  total_lines_removed?: number;
  uuid: string;
  session_id: string;
}

export interface CLIStreamEventMessage {
  type: "stream_event";
  event: unknown;
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}

export interface CLIToolProgressMessage {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  uuid: string;
  session_id: string;
}

export interface CLIToolUseSummaryMessage {
  type: "tool_use_summary";
  summary: string;
  preceding_tool_use_ids: string[];
  uuid: string;
  session_id: string;
}

export interface CLIControlRequestMessage {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    permission_suggestions?: PermissionUpdate[];
    description?: string;
    tool_use_id: string;
    agent_id?: string;
  };
}

export interface CLIKeepAliveMessage {
  type: "keep_alive";
}

export interface CLIAuthStatusMessage {
  type: "auth_status";
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  uuid: string;
  session_id: string;
}

export interface CLIControlResponseMessage {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    response?: Record<string, unknown>;
    error?: string;
  };
}

export type CLIMessage =
  | CLISystemInitMessage
  | CLISystemStatusMessage
  | CLIAssistantMessage
  | CLIResultMessage
  | CLIStreamEventMessage
  | CLIToolProgressMessage
  | CLIToolUseSummaryMessage
  | CLIControlRequestMessage
  | CLIControlResponseMessage
  | CLIKeepAliveMessage
  | CLIAuthStatusMessage;

// ─── Content Block Types ──────────────────────────────────────────────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
  | { type: "thinking"; thinking: string; budget_tokens?: number };

// ─── Browser Message Types (browser <-> bridge) ──────────────────────────────

/** Messages the browser sends to the bridge */
export type BrowserOutgoingMessage =
  | { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[]; client_msg_id?: string }
  | { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown>; updated_permissions?: PermissionUpdate[]; message?: string; client_msg_id?: string }
  | { type: "session_subscribe"; last_seq: number }
  | { type: "session_ack"; last_seq: number }
  | { type: "interrupt"; client_msg_id?: string }
  | { type: "set_model"; model: string; client_msg_id?: string }
  | { type: "set_permission_mode"; mode: string; client_msg_id?: string }
  | { type: "mcp_get_status"; client_msg_id?: string }
  | { type: "mcp_toggle"; serverName: string; enabled: boolean; client_msg_id?: string }
  | { type: "mcp_reconnect"; serverName: string; client_msg_id?: string }
  | { type: "mcp_set_servers"; servers: Record<string, McpServerConfig>; client_msg_id?: string };

/** Messages the bridge sends to the browser */
export type BrowserIncomingMessageBase =
  | { type: "session_init"; session: SessionState }
  | { type: "session_update"; session: Partial<SessionState> }
  | { type: "assistant"; message: CLIAssistantMessage["message"]; parent_tool_use_id: string | null; timestamp?: number }
  | { type: "stream_event"; event: unknown; parent_tool_use_id: string | null }
  | { type: "result"; data: CLIResultMessage }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_cancelled"; request_id: string }
  | { type: "tool_progress"; tool_use_id: string; tool_name: string; elapsed_time_seconds: number }
  | { type: "tool_use_summary"; summary: string; tool_use_ids: string[] }
  | { type: "status_change"; status: "compacting" | "idle" | "running" | null }
  | { type: "auth_status"; isAuthenticating: boolean; output: string[]; error?: string }
  | { type: "error"; message: string }
  | { type: "cli_disconnected" }
  | { type: "cli_connected" }
  | { type: "user_message"; content: string; timestamp: number; id?: string }
  | { type: "message_history"; messages: BrowserIncomingMessage[] }
  | { type: "event_replay"; events: BufferedBrowserEvent[] }
  | { type: "session_name_update"; name: string }
  | { type: "pr_status_update"; pr: import("./github-pr.js").GitHubPRInfo | null; available: boolean }
  | { type: "mcp_status"; servers: McpServerDetail[] };

export type BrowserIncomingMessage = BrowserIncomingMessageBase & { seq?: number };

export type ReplayableBrowserIncomingMessage = Exclude<BrowserIncomingMessageBase, { type: "event_replay" }>;

export interface BufferedBrowserEvent {
  seq: number;
  message: ReplayableBrowserIncomingMessage;
}

// ─── Session State ────────────────────────────────────────────────────────────

export type BackendType = "claude" | "codex";

export interface SessionState {
  session_id: string;
  backend_type?: BackendType;
  model: string;
  cwd: string;
  tools: string[];
  permissionMode: string;
  claude_code_version: string;
  mcp_servers: { name: string; status: string }[];
  agents: string[];
  slash_commands: string[];
  skills: string[];
  total_cost_usd: number;
  num_turns: number;
  context_used_percent: number;
  is_compacting: boolean;
  git_branch: string;
  is_worktree: boolean;
  repo_root: string;
  git_ahead: number;
  git_behind: number;
  total_lines_added: number;
  total_lines_removed: number;
  // Codex-specific token details (forwarded from thread/tokenUsage/updated)
  codex_token_details?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningOutputTokens: number;
    modelContextWindow: number;
  };
  // Codex-specific rate limits (forwarded from account/rateLimits/updated)
  codex_rate_limits?: {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  };
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
}

// ─── MCP Types ───────────────────────────────────────────────────────────────

export interface McpServerConfig {
  type: "stdio" | "sse" | "http" | "sdk";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface McpServerDetail {
  name: string;
  status: "connected" | "failed" | "disabled" | "connecting";
  serverInfo?: unknown;
  error?: string;
  config: { type: string; url?: string; command?: string; args?: string[] };
  scope: string;
  tools?: { name: string; annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean } }[];
}

// ─── Permission Request ──────────────────────────────────────────────────────

// ─── Permission Rule Types ───────────────────────────────────────────────────

export type PermissionDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";

export type PermissionUpdate =
  | { type: "addRules"; rules: { toolName: string; ruleContent?: string }[]; behavior: "allow" | "deny" | "ask"; destination: PermissionDestination }
  | { type: "replaceRules"; rules: { toolName: string; ruleContent?: string }[]; behavior: "allow" | "deny" | "ask"; destination: PermissionDestination }
  | { type: "removeRules"; rules: { toolName: string; ruleContent?: string }[]; behavior: "allow" | "deny" | "ask"; destination: PermissionDestination }
  | { type: "setMode"; mode: string; destination: PermissionDestination }
  | { type: "addDirectories"; directories: string[]; destination: PermissionDestination }
  | { type: "removeDirectories"; directories: string[]; destination: PermissionDestination };

export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  permission_suggestions?: PermissionUpdate[];
  description?: string;
  tool_use_id: string;
  agent_id?: string;
  timestamp: number;
}
