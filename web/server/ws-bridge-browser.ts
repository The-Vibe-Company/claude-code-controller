import type { ServerWebSocket } from "bun";
import type { BrowserSocketData, Session, SocketData } from "./ws-bridge-types.js";
import type {
  BrowserIncomingMessage,
  ReplayableBrowserIncomingMessage,
} from "./session-types.js";

export function handleSessionSubscribe(
  session: Session,
  ws: ServerWebSocket<SocketData> | undefined,
  lastSeq: number,
  sendToBrowser: (ws: ServerWebSocket<SocketData>, msg: BrowserIncomingMessage) => void,
  isHistoryBackedEvent: (msg: ReplayableBrowserIncomingMessage) => boolean,
): void {
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
    sendToBrowser(ws, {
      type: "message_history",
      messages: session.messageHistory,
    });
    const transientMissed = session.eventBuffer
      .filter((evt) => evt.seq > lastAckSeq && !isHistoryBackedEvent(evt.message));
    if (transientMissed.length > 0) {
      sendToBrowser(ws, {
        type: "event_replay",
        events: transientMissed,
      });
    }
    return;
  }

  const missed = session.eventBuffer.filter((evt) => evt.seq > lastAckSeq);
  if (missed.length === 0) return;
  sendToBrowser(ws, {
    type: "event_replay",
    events: missed,
  });
}

export function handleSessionAck(
  session: Session,
  ws: ServerWebSocket<SocketData> | undefined,
  lastSeq: number,
  persistSession: (session: Session) => void,
): void {
  const normalized = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
  if (ws) {
    const data = ws.data as BrowserSocketData;
    const prior = typeof data.lastAckSeq === "number" ? data.lastAckSeq : 0;
    data.lastAckSeq = Math.max(prior, normalized);
  }
  if (normalized > session.lastAckSeq) {
    session.lastAckSeq = normalized;
    persistSession(session);
  }
}

export function handlePermissionResponse(
  session: Session,
  msg: {
    type: "permission_response";
    request_id: string;
    behavior: "allow" | "deny";
    updated_input?: Record<string, unknown>;
    updated_permissions?: unknown[];
    message?: string;
  },
  sendToCLI: (session: Session, ndjson: string) => void,
): void {
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
    sendToCLI(session, ndjson);
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
    sendToCLI(session, ndjson);
  }
}
