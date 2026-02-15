import { useStore } from "../store.js";
import type { AgentInfo } from "../types.js";

function agentIcon(type: string): string {
  const icons: Record<string, string> = {
    "coder": "C",
    "architect": "A",
    "reviewer": "R",
    "tdd": "T",
    "researcher": "Rs",
    "debugger": "D",
    "documenter": "Dc",
    "security-auditor": "S",
    "deploy-runner": "Dr",
    "explore": "Ex",
    "plan": "Pl",
    "general-purpose": "G",
  };
  return icons[type.toLowerCase()] || type.charAt(0).toUpperCase();
}

function statusColor(status: AgentInfo["status"]): string {
  switch (status) {
    case "running": return "bg-green-500";
    case "idle": return "bg-yellow-500";
    case "stopped": return "bg-cc-muted";
    default: return "bg-cc-muted";
  }
}

/** Open (or focus) an agent tab */
function openAgentTab(sessionId: string, agent: AgentInfo) {
  const url = `${window.location.origin}${window.location.pathname}#/agent/${sessionId}/${agent.agentId}`;
  // Use agent ID as window name so repeated clicks focus existing tab
  window.open(url, `agent-${agent.agentId}`);
}

export function AgentTabBar({ sessionId }: { sessionId: string }) {
  const agents = useStore((s) => s.sessionAgents.get(sessionId) || []);

  if (agents.length === 0) return null;

  const runningCount = agents.filter(a => a.status === "running").length;
  const idleCount = agents.filter(a => a.status === "idle").length;

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 bg-cc-card border-b border-cc-border overflow-x-auto shrink-0">
      {/* Agent count summary */}
      <span className="text-[10px] text-cc-muted shrink-0 mr-1">
        {agents.length} agent{agents.length !== 1 ? "s" : ""}
        {runningCount > 0 && <span className="text-green-500 ml-1">{runningCount} running</span>}
        {idleCount > 0 && <span className="text-yellow-500 ml-1">{idleCount} idle</span>}
      </span>

      <div className="w-px h-4 bg-cc-border mx-1" />

      {/* Agent tabs — click opens new browser tab */}
      {agents.map((agent) => (
        <button
          key={agent.agentId}
          onClick={() => openAgentTab(sessionId, agent)}
          className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
          title={`Open ${agent.agentName || agent.agentType} in new tab (${agent.status})`}
        >
          <span className="relative">
            <span className="w-4 h-4 rounded-full bg-cc-hover flex items-center justify-center text-[10px] font-bold">
              {agentIcon(agent.agentType)}
            </span>
            <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${statusColor(agent.status)} ring-1 ring-cc-card`} />
          </span>
          <span className="max-w-[100px] truncate">
            {agent.agentName || agent.agentType}
          </span>
          {/* External link icon */}
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-2.5 h-2.5 opacity-40">
            <path d="M4.5 1.5H2a.5.5 0 00-.5.5v8a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V7.5M7.5 1.5h3v3M6 6l4.5-4.5" />
          </svg>
        </button>
      ))}

      {/* Open All button */}
      {agents.length > 1 && (
        <>
          <div className="w-px h-4 bg-cc-border mx-1" />
          <button
            onClick={() => {
              // Stagger opens to avoid popup blockers — first one is synchronous (user gesture),
              // rest use small delays. Browsers may still block some; users can click individually.
              agents.forEach((agent, i) => {
                if (i === 0) {
                  openAgentTab(sessionId, agent);
                } else {
                  setTimeout(() => openAgentTab(sessionId, agent), i * 100);
                }
              });
            }}
            className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors cursor-pointer text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            title="Open all agents in separate tabs"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
              <rect x="1" y="2" width="14" height="12" rx="1" />
              <line x1="8" y1="2" x2="8" y2="14" />
            </svg>
            <span>Open All</span>
          </button>
        </>
      )}
    </div>
  );
}
