import { useMemo } from "react";
import { useStore, type QuickTerminalPlacement } from "../store.js";
import { TerminalView } from "./TerminalView.js";

interface SessionTerminalDockProps {
  sessionId: string;
  children: React.ReactNode;
}

function placementLayout(placement: QuickTerminalPlacement) {
  if (placement === "left") {
    return {
      shellClass: "flex-row",
      terminalWrapClass: "w-[42%] min-w-[300px] max-w-[70%] border-r border-cc-border order-1",
      contentWrapClass: "flex-1 min-w-0 order-2",
    };
  }
  if (placement === "right") {
    return {
      shellClass: "flex-row",
      terminalWrapClass: "w-[42%] min-w-[300px] max-w-[70%] border-l border-cc-border order-2",
      contentWrapClass: "flex-1 min-w-0 order-1",
    };
  }
  if (placement === "top") {
    return {
      shellClass: "flex-col",
      terminalWrapClass: "h-[38%] min-h-[220px] max-h-[70%] border-b border-cc-border order-1",
      contentWrapClass: "flex-1 min-h-0 order-2",
    };
  }
  return {
    shellClass: "flex-col",
    terminalWrapClass: "h-[38%] min-h-[220px] max-h-[70%] border-t border-cc-border order-2",
    contentWrapClass: "flex-1 min-h-0 order-1",
  };
}

export function SessionTerminalDock({ sessionId, children }: SessionTerminalDockProps) {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const quickTerminalOpen = useStore((s) => s.quickTerminalOpen);
  const quickTerminalTabs = useStore((s) => s.quickTerminalTabs);
  const activeQuickTerminalTabId = useStore((s) => s.activeQuickTerminalTabId);
  const quickTerminalPlacement = useStore((s) => s.quickTerminalPlacement);
  const setQuickTerminalOpen = useStore((s) => s.setQuickTerminalOpen);
  const openQuickTerminal = useStore((s) => s.openQuickTerminal);
  const closeQuickTerminalTab = useStore((s) => s.closeQuickTerminalTab);
  const setActiveQuickTerminalTabId = useStore((s) => s.setActiveQuickTerminalTabId);
  const setQuickTerminalPlacement = useStore((s) => s.setQuickTerminalPlacement);

  const cwd = useStore((s) => {
    if (!currentSessionId) return null;
    return (
      s.sessions.get(currentSessionId)?.cwd
      || s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId)?.cwd
      || null
    );
  });
  const sdkSession = useStore((s) => {
    if (!currentSessionId) return null;
    return s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId) || null;
  });
  const defaultNewTerminalOpts = sdkSession?.containerId
    ? { target: "docker" as const, cwd: "/workspace", containerId: sdkSession.containerId }
    : (cwd ? { target: "host" as const, cwd } : null);

  const hasPanel = currentSessionId === sessionId && quickTerminalOpen && quickTerminalTabs.length > 0;
  const layout = useMemo(
    () => placementLayout(quickTerminalPlacement),
    [quickTerminalPlacement],
  );

  if (!hasPanel) {
    return <>{children}</>;
  }

  return (
    <div className={`h-full min-h-0 flex ${layout.shellClass}`}>
      <div className={layout.contentWrapClass}>{children}</div>

      <div className={`min-h-0 shrink-0 bg-cc-card ${layout.terminalWrapClass}`}>
        <div className="h-full min-h-0 flex flex-col">
          <div className="px-2 py-1.5 border-b border-cc-border bg-cc-sidebar flex items-center gap-2">
            <div className="flex-1 min-w-0 overflow-x-auto">
              <div className="flex items-center gap-1.5 min-w-max">
              {quickTerminalTabs.map((tab) => (
                <div
                  key={tab.id}
                  onClick={() => setActiveQuickTerminalTabId(tab.id)}
                  className={`group inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                    activeQuickTerminalTabId === tab.id
                      ? "text-cc-fg bg-cc-card border-cc-border"
                      : "text-cc-muted bg-transparent border-transparent hover:text-cc-fg hover:bg-cc-hover"
                  }`}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActiveQuickTerminalTabId(tab.id);
                    }
                  }}
                >
                  <span>{tab.label}</span>
                  <button
                    type="button"
                    aria-label={`Close ${tab.label} terminal tab`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeQuickTerminalTab(tab.id);
                    }}
                    className="w-4 h-4 rounded-sm flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                  >
                    ×
                  </button>
                </div>
              ))}
              </div>
            </div>

            <div className="shrink-0 flex items-center gap-1">
              <select
                value={quickTerminalPlacement}
                onChange={(e) => setQuickTerminalPlacement(e.target.value as QuickTerminalPlacement)}
                className="h-7 px-2 rounded-md border border-cc-border bg-cc-hover text-[11px] text-cc-muted focus:outline-none focus:border-cc-primary/50"
                title="Dock position"
                aria-label="Dock position"
              >
                <option value="top">Top</option>
                <option value="right">Right</option>
                <option value="bottom">Bottom</option>
                <option value="left">Left</option>
              </select>
              {cwd && (
                <button
                  onClick={() => defaultNewTerminalOpts && openQuickTerminal(defaultNewTerminalOpts)}
                  className="px-2 py-1 rounded-md text-[11px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                  title={sdkSession?.containerId ? "Open terminal in session container" : "Open terminal on host machine"}
                >
                  + Terminal
                </button>
              )}
              <button
                onClick={() => setQuickTerminalOpen(false)}
                className="ml-1 px-2 py-1 rounded-md text-[11px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 bg-cc-bg">
            {quickTerminalTabs.map((tab) => (
              <div key={tab.id} className={activeQuickTerminalTabId === tab.id ? "h-full" : "hidden"}>
                <TerminalView
                  cwd={tab.cwd}
                  containerId={tab.containerId}
                  title={tab.containerId ? `docker:${tab.cwd}` : tab.cwd}
                  embedded
                  visible={activeQuickTerminalTabId === tab.id}
                  hideHeader
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
