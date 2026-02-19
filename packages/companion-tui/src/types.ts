// Companion browser WebSocket protocol types
// Reverse-engineered from The-Vibe-Company/companion

export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ContentBlock[];
      is_error?: boolean;
    }
  | { type: "thinking"; thinking: string; budget_tokens?: number };

export interface SessionState {
  session_id: string;
  backend_type?: "claude" | "codex";
  model: string;
  cwd: string;
  tools: string[];
  permissionMode: string;
  claude_code_version: string;
  mcp_servers: { name: string; status: string }[];
  total_cost_usd: number;
  num_turns: number;
  context_used_percent: number;
  is_compacting: boolean;
}

export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  description?: string;
  tool_use_id: string;
  agent_id?: string;
  timestamp: number;
}

export interface AssistantMessage {
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
}

export interface ResultData {
  type: "result";
  subtype: string;
  is_error: boolean;
  result?: string;
  errors?: string[];
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  session_id: string;
}

// Messages FROM Companion server TO browser/TUI clients
export type ServerMessage =
  | { type: "session_init"; session: SessionState; seq?: number }
  | { type: "session_update"; session: Partial<SessionState>; seq?: number }
  | {
      type: "assistant";
      message: AssistantMessage;
      parent_tool_use_id: string | null;
      timestamp?: number;
      seq?: number;
    }
  | {
      type: "stream_event";
      event: StreamEvent;
      parent_tool_use_id: string | null;
      seq?: number;
    }
  | { type: "result"; data: ResultData; seq?: number }
  | {
      type: "permission_request";
      request: PermissionRequest;
      seq?: number;
    }
  | { type: "permission_cancelled"; request_id: string; seq?: number }
  | {
      type: "tool_progress";
      tool_use_id: string;
      tool_name: string;
      elapsed_time_seconds: number;
      seq?: number;
    }
  | {
      type: "tool_use_summary";
      summary: string;
      tool_use_ids: string[];
      seq?: number;
    }
  | {
      type: "status_change";
      status: "compacting" | "idle" | "running" | null;
      seq?: number;
    }
  | { type: "error"; message: string; seq?: number }
  | { type: "cli_disconnected"; seq?: number }
  | { type: "cli_connected"; seq?: number }
  | {
      type: "user_message";
      content: string;
      timestamp: number;
      id?: string;
      sender_client_id?: string;
      seq?: number;
    }
  | {
      type: "message_history";
      messages: ServerMessage[];
      seq?: number;
    }
  | {
      type: "event_replay";
      events: Array<{ msg: ServerMessage; seq: number }>;
      seq?: number;
    }
  | { type: "session_name_update"; name: string; seq?: number }
  | { type: "mcp_status"; servers: McpServerDetail[]; seq?: number };

// Stream events (from Anthropic API, proxied through CLI)
export type StreamEvent =
  | {
      type: "content_block_start";
      index: number;
      content_block: ContentBlock;
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "thinking_delta"; thinking: string }
        | {
            type: "input_json_delta";
            partial_json: string;
          };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_start";
      message: { id: string; model: string; role: string };
    }
  | { type: "message_delta"; delta: { stop_reason: string } }
  | { type: "message_stop" };

// MCP server detail (returned by mcp_status)
export interface McpServerDetail {
  name: string;
  status: "connected" | "failed" | "disabled" | "connecting";
  serverInfo?: unknown;
  error?: string;
  config: { type: string; url?: string; command?: string; args?: string[] };
  scope: string;
  tools?: {
    name: string;
    annotations?: {
      readOnly?: boolean;
      destructive?: boolean;
      openWorld?: boolean;
    };
  }[];
}

// Messages FROM browser/TUI clients TO Companion server
export type ClientMessage =
  | {
      type: "user_message";
      content: string;
      session_id?: string;
      images?: { media_type: string; data: string }[];
      client_msg_id?: string;
    }
  | {
      type: "permission_response";
      request_id: string;
      behavior: "allow" | "deny";
      updated_input?: Record<string, unknown>;
      client_msg_id?: string;
    }
  | { type: "session_subscribe"; last_seq: number; client_id?: string }
  | { type: "session_ack"; last_seq: number }
  | { type: "interrupt"; client_msg_id?: string }
  | { type: "set_model"; model: string; client_msg_id?: string }
  | {
      type: "set_permission_mode";
      mode: string;
      client_msg_id?: string;
    }
  | { type: "mcp_get_status"; client_msg_id?: string }
  | {
      type: "mcp_toggle";
      serverName: string;
      enabled: boolean;
      client_msg_id?: string;
    }
  | { type: "mcp_reconnect"; serverName: string; client_msg_id?: string };
