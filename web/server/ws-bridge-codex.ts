import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  SessionState,
} from "./session-types.js";
import type { CodexAdapter } from "./codex-adapter.js";
import type { Session } from "./ws-bridge-types.js";

export interface CodexAttachDeps {
  persistSession: (session: Session) => void;
  refreshGitInfo: (
    session: Session,
    options?: { broadcastUpdate?: boolean; notifyPoller?: boolean },
  ) => void;
  broadcastToBrowsers: (session: Session, msg: BrowserIncomingMessage) => void;
  onCLISessionId: ((sessionId: string, cliSessionId: string) => void) | null;
  onFirstTurnCompleted: ((sessionId: string, firstUserMessage: string) => void) | null;
  autoNamingAttempted: Set<string>;
}

export function attachCodexAdapterHandlers(
  sessionId: string,
  session: Session,
  adapter: CodexAdapter,
  deps: CodexAttachDeps,
): void {
  adapter.onBrowserMessage((msg) => {
    if (msg.type === "session_init") {
      session.state = { ...session.state, ...msg.session, backend_type: "codex" };
      deps.refreshGitInfo(session, { notifyPoller: true });
      deps.persistSession(session);
    } else if (msg.type === "session_update") {
      session.state = { ...session.state, ...msg.session, backend_type: "codex" };
      deps.refreshGitInfo(session, { notifyPoller: true });
      deps.persistSession(session);
    } else if (msg.type === "status_change") {
      session.state.is_compacting = msg.status === "compacting";
      deps.persistSession(session);
    }

    if (msg.type === "assistant") {
      session.messageHistory.push({ ...msg, timestamp: msg.timestamp || Date.now() });
      deps.persistSession(session);
    } else if (msg.type === "result") {
      session.messageHistory.push(msg);
      deps.persistSession(session);
    }

    if (msg.type === "assistant") {
      const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content;
      const hasToolUse = content?.some((b) => b.type === "tool_use");
      if (hasToolUse) {
        console.log(`[ws-bridge] Broadcasting tool_use assistant to ${session.browserSockets.size} browser(s) for session ${session.id}`);
      }
    }

    if (msg.type === "permission_request") {
      session.pendingPermissions.set(msg.request.request_id, msg.request);
      deps.persistSession(session);
    }

    deps.broadcastToBrowsers(session, msg);

    if (
      msg.type === "result" &&
      !(msg.data as { is_error?: boolean }).is_error &&
      deps.onFirstTurnCompleted &&
      !deps.autoNamingAttempted.has(session.id)
    ) {
      deps.autoNamingAttempted.add(session.id);
      const firstUserMsg = session.messageHistory.find((m) => m.type === "user_message");
      if (firstUserMsg && firstUserMsg.type === "user_message") {
        deps.onFirstTurnCompleted(session.id, firstUserMsg.content);
      }
    }
  });

  adapter.onSessionMeta((meta) => {
    if (meta.cliSessionId && deps.onCLISessionId) {
      deps.onCLISessionId(session.id, meta.cliSessionId);
    }
    if (meta.model) session.state.model = meta.model;
    if (meta.cwd) session.state.cwd = meta.cwd;
    session.state.backend_type = "codex";
    deps.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });
    deps.persistSession(session);
  });

  adapter.onDisconnect(() => {
    for (const [reqId] of session.pendingPermissions) {
      deps.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
    }
    session.pendingPermissions.clear();
    session.codexAdapter = null;
    deps.persistSession(session);
    console.log(`[ws-bridge] Codex adapter disconnected for session ${sessionId}`);
    deps.broadcastToBrowsers(session, { type: "cli_disconnected" });
  });

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

  deps.broadcastToBrowsers(session, { type: "cli_connected" });
  console.log(`[ws-bridge] Codex adapter attached for session ${sessionId}`);
}
