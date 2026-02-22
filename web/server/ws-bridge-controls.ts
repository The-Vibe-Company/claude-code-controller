import { randomUUID } from "node:crypto";
import type {
  CLIControlResponseMessage,
  BrowserIncomingMessage,
  McpServerDetail,
} from "./session-types.js";
import type { Session } from "./ws-bridge-types.js";

export function handleInterrupt(
  session: Session,
  sendToCLI: (session: Session, ndjson: string) => void,
): void {
  const ndjson = JSON.stringify({
    type: "control_request",
    request_id: randomUUID(),
    request: { subtype: "interrupt" },
  });
  sendToCLI(session, ndjson);
}

export function handleSetModel(
  session: Session,
  model: string,
  sendToCLI: (session: Session, ndjson: string) => void,
): void {
  const ndjson = JSON.stringify({
    type: "control_request",
    request_id: randomUUID(),
    request: { subtype: "set_model", model },
  });
  sendToCLI(session, ndjson);
}

export function handleSetPermissionMode(
  session: Session,
  mode: string,
  sendToCLI: (session: Session, ndjson: string) => void,
): void {
  const ndjson = JSON.stringify({
    type: "control_request",
    request_id: randomUUID(),
    request: { subtype: "set_permission_mode", mode },
  });
  sendToCLI(session, ndjson);
}

export function handleControlResponse(
  session: Session,
  msg: CLIControlResponseMessage,
  loggerWarn: (message: string) => void,
): void {
  const reqId = msg.response.request_id;
  const pending = session.pendingControlRequests.get(reqId);
  if (!pending) return;
  session.pendingControlRequests.delete(reqId);
  if (msg.response.subtype === "error") {
    loggerWarn(`[ws-bridge] Control request ${pending.subtype} failed: ${msg.response.error}`);
    return;
  }
  pending.resolve(msg.response.response ?? {});
}

export function sendControlRequest(
  session: Session,
  request: Record<string, unknown>,
  sendToCLI: (session: Session, ndjson: string) => void,
  onResponse?: { subtype: string; resolve: (response: unknown) => void },
): void {
  const requestId = randomUUID();
  if (onResponse) {
    session.pendingControlRequests.set(requestId, onResponse);
  }
  const ndjson = JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request,
  });
  sendToCLI(session, ndjson);
}

export function handleMcpGetStatus(
  session: Session,
  sendControlRequestFn: (
    request: Record<string, unknown>,
    onResponse?: { subtype: string; resolve: (response: unknown) => void },
  ) => void,
  broadcastToBrowsers: (session: Session, msg: BrowserIncomingMessage) => void,
): void {
  sendControlRequestFn({ subtype: "mcp_status" }, {
    subtype: "mcp_status",
    resolve: (response) => {
      const servers = (response as { mcpServers?: McpServerDetail[] }).mcpServers ?? [];
      broadcastToBrowsers(session, { type: "mcp_status", servers });
    },
  });
}

export function handleMcpToggle(
  sendControlRequestFn: (request: Record<string, unknown>) => void,
  serverName: string,
  enabled: boolean,
  refreshStatus: () => void,
): void {
  sendControlRequestFn({ subtype: "mcp_toggle", serverName, enabled });
  setTimeout(refreshStatus, 500);
}

export function handleMcpReconnect(
  sendControlRequestFn: (request: Record<string, unknown>) => void,
  serverName: string,
  refreshStatus: () => void,
): void {
  sendControlRequestFn({ subtype: "mcp_reconnect", serverName });
  setTimeout(refreshStatus, 1000);
}

export function handleMcpSetServers(
  sendControlRequestFn: (request: Record<string, unknown>) => void,
  servers: Record<string, unknown>,
  refreshStatus: () => void,
): void {
  sendControlRequestFn({ subtype: "mcp_set_servers", servers });
  setTimeout(refreshStatus, 2000);
}
