// WebSocket client for connecting to Companion server as a "browser" client

import WebSocket from "ws"; // eslint-disable-line
import type {
  ClientMessage,
  ServerMessage,
  SessionState,
} from "./types.ts";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface CompanionClientOptions {
  host: string; // e.g. "localhost:3456"
  sessionId: string;
  onMessage: (msg: ServerMessage) => void;
  onStatusChange: (status: ConnectionStatus) => void;
}

export class CompanionClient {
  private ws: WebSocket | null = null;
  private lastSeq = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  readonly clientId = `tui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(private opts: CompanionClientOptions) {}

  connect(): void {
    if (this.disposed) return;
    this.opts.onStatusChange("connecting");

    const url = `ws://${this.opts.host}/ws/browser/${this.opts.sessionId}`;
    const ws = new WebSocket(url);

    ws.on("open", () => {
      this.opts.onStatusChange("connected");
      this.send({ type: "session_subscribe", last_seq: this.lastSeq, client_id: this.clientId });
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        if ("seq" in msg && typeof msg.seq === "number") {
          this.lastSeq = msg.seq;
        }
        this.opts.onMessage(msg);
      } catch {
        // ignore unparseable messages
      }
    });

    ws.on("close", () => {
      this.ws = null;
      this.opts.onStatusChange("disconnected");
      this.scheduleReconnect();
    });

    ws.on("error", () => {
      // error is followed by close
    });

    this.ws = ws;
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendUserMessage(
    content: string,
    images?: { media_type: string; data: string }[],
  ): void {
    this.send({
      type: "user_message",
      content,
      ...(images && images.length > 0 ? { images } : {}),
      client_msg_id: crypto.randomUUID(),
    });
  }

  sendPermissionResponse(
    requestId: string,
    behavior: "allow" | "deny",
  ): void {
    this.send({
      type: "permission_response",
      request_id: requestId,
      behavior,
      client_msg_id: crypto.randomUUID(),
    });
  }

  interrupt(): void {
    this.send({ type: "interrupt", client_msg_id: crypto.randomUUID() });
  }

  setModel(model: string): void {
    this.send({
      type: "set_model",
      model,
      client_msg_id: crypto.randomUUID(),
    });
  }

  setPermissionMode(mode: string): void {
    this.send({
      type: "set_permission_mode",
      mode,
      client_msg_id: crypto.randomUUID(),
    });
  }

  mcpGetStatus(): void {
    this.send({
      type: "mcp_get_status",
      client_msg_id: crypto.randomUUID(),
    });
  }

  mcpToggle(serverName: string, enabled: boolean): void {
    this.send({
      type: "mcp_toggle",
      serverName,
      enabled,
      client_msg_id: crypto.randomUUID(),
    });
  }

  mcpReconnect(serverName: string): void {
    this.send({
      type: "mcp_reconnect",
      serverName,
      client_msg_id: crypto.randomUUID(),
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, 2000);
  }
}

// REST API helpers for session management
export interface SessionInfo {
  sessionId: string;
  state: string;
  cwd: string;
  createdAt: number;
  numTurns?: number;
  name?: string;
  backendType?: string;
  cliSessionId?: string;
  pid?: number;
}

export interface BackendModelInfo {
  value: string;
  label: string;
  description: string;
}

export async function listSessions(
  host: string,
): Promise<SessionInfo[]> {
  const res = await fetch(`http://${host}/api/sessions`);
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`);
  return (await res.json()) as SessionInfo[];
}

export interface CreateSessionOpts {
  model?: string;
  permissionMode?: string;
  cwd?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
}

export async function createSession(
  host: string,
  opts: CreateSessionOpts = {},
): Promise<{ sessionId: string; state: string; cwd: string; name?: string }> {
  const res = await fetch(`http://${host}/api/sessions/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  return (await res.json()) as {
    sessionId: string;
    state: string;
    cwd: string;
    name?: string;
  };
}

export async function killSession(
  host: string,
  sessionId: string,
): Promise<void> {
  const res = await fetch(`http://${host}/api/sessions/${sessionId}/kill`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to kill session: ${res.status}`);
}

export async function relaunchSession(
  host: string,
  sessionId: string,
): Promise<void> {
  const res = await fetch(
    `http://${host}/api/sessions/${sessionId}/relaunch`,
    { method: "POST" },
  );
  if (!res.ok)
    throw new Error(`Failed to relaunch session: ${res.status}`);
}

export async function getSession(
  host: string,
  sessionId: string,
): Promise<SessionInfo | null> {
  const res = await fetch(`http://${host}/api/sessions/${sessionId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to get session: ${res.status}`);
  return (await res.json()) as SessionInfo;
}

export async function listBackendModels(
  host: string,
  backendId: "claude" | "codex",
): Promise<BackendModelInfo[]> {
  const res = await fetch(
    `http://${host}/api/backends/${encodeURIComponent(backendId)}/models`,
  );
  if (!res.ok) {
    throw new Error(`Failed to list ${backendId} models: ${res.status}`);
  }
  return (await res.json()) as BackendModelInfo[];
}
