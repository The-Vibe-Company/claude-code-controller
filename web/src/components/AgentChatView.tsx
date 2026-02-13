import { useEffect } from "react";
import { useStore } from "../store.js";
import { connectSession } from "../ws.js";
import { MessageFeed } from "./MessageFeed.js";

/** Inline agent view used as a component (e.g. inside split panes) */
export function AgentChatView({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const agents = useStore((s) => s.sessionAgents.get(sessionId) || []);
  const agent = agents.find(a => a.agentId === agentId);
  const agentName = agent?.agentName || agent?.agentType || "Agent";
  const agentStatus = agent?.status || "stopped";

  return (
    <div className="flex flex-col h-full min-h-0">
      <AgentHeader name={agentName} type={agent?.agentType} status={agentStatus} />
      <MessageFeed sessionId={sessionId} filterParentToolUseId={agentId} />
    </div>
  );
}

/** Full-page agent view — renders in its own browser tab via #/agent/:sessionId/:agentId */
export function AgentPage({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const darkMode = useStore((s) => s.darkMode);
  const agents = useStore((s) => s.sessionAgents.get(sessionId) || []);
  const agent = agents.find(a => a.agentId === agentId);
  const agentName = agent?.agentName || agent?.agentType || "Agent";
  const agentStatus = agent?.status || "stopped";
  const connectionStatus = useStore((s) => s.connectionStatus.get(sessionId) || "disconnected");

  // Apply dark mode
  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  // Connect WebSocket for this session
  useEffect(() => {
    connectSession(sessionId);
  }, [sessionId]);

  // Update document title with agent name
  useEffect(() => {
    document.title = `${agentName} — Companion`;
    return () => { document.title = "The Companion"; };
  }, [agentName]);

  return (
    <div className="h-[100dvh] flex flex-col font-sans-ui bg-cc-bg text-cc-fg antialiased">
      {/* Connection bar */}
      {connectionStatus !== "connected" && (
        <div className="px-3 py-1.5 text-xs text-center bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-b border-cc-border">
          {connectionStatus === "connecting" ? "Connecting to session..." : "Disconnected — reconnecting..."}
        </div>
      )}

      {/* Agent header */}
      <AgentHeader name={agentName} type={agent?.agentType} status={agentStatus} />

      {/* Message feed */}
      <div className="flex-1 overflow-hidden">
        <MessageFeed sessionId={sessionId} filterParentToolUseId={agentId} />
      </div>
    </div>
  );
}

/** Shared header bar for agent views */
function AgentHeader({ name, type, status }: { name: string; type?: string; status: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 bg-cc-card border-b border-cc-border shrink-0">
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${
        status === "running" ? "bg-green-500 animate-pulse" :
        status === "idle" ? "bg-yellow-500" : "bg-cc-muted"
      }`} />
      <span className="text-sm font-medium text-cc-fg truncate">{name}</span>
      {type && (
        <span className="text-[11px] text-cc-muted px-1.5 py-0.5 rounded bg-cc-hover shrink-0">
          {type}
        </span>
      )}
      <span className={`text-[11px] ml-auto shrink-0 ${
        status === "running" ? "text-green-500" :
        status === "idle" ? "text-yellow-500" : "text-cc-muted"
      }`}>
        {status}
      </span>
    </div>
  );
}
