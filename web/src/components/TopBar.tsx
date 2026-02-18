import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { ClaudeMdEditor } from "./ClaudeMdEditor.js";
import { TerminalView } from "./TerminalView.js";
import { parseHash } from "../utils/routing.js";

interface QuickTerminalTab {
  id: string;
  label: string;
  cwd: string;
  containerId?: string;
}

export function TopBar() {
  const hash = useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => window.location.hash,
  );
  const route = useMemo(() => parseHash(hash), [hash]);
  const isSessionView = route.page === "session" || route.page === "home";
  const currentSessionId = useStore((s) => s.currentSessionId);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const sessionNames = useStore((s) => s.sessionNames);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const assistantSessionId = useStore((s) => s.assistantSessionId);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const [claudeMdOpen, setClaudeMdOpen] = useState(false);
  const [terminalPanelOpen, setTerminalPanelOpen] = useState(false);
  const [terminalTabs, setTerminalTabs] = useState<QuickTerminalTab[]>([]);
  const [activeTerminalTabId, setActiveTerminalTabId] = useState<string | null>(null);
  const changedFilesCount = useStore((s) => {
    if (!currentSessionId) return 0;
    const cwd =
      s.sessions.get(currentSessionId)?.cwd ||
      s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId)?.cwd;
    const files = s.changedFiles.get(currentSessionId);
    if (!files) return 0;
    if (!cwd) return files.size;
    const prefix = `${cwd}/`;
    return [...files].filter((fp) => fp === cwd || fp.startsWith(prefix)).length;
  });

  const cwd = useStore((s) => {
    if (!currentSessionId) return null;
    return (
      s.sessions.get(currentSessionId)?.cwd ||
      s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId)?.cwd ||
      null
    );
  });
  const sdkSession = useStore((s) => {
    if (!currentSessionId) return null;
    return s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId) || null;
  });
  const bridgeSession = useStore((s) => {
    if (!currentSessionId) return null;
    return s.sessions.get(currentSessionId) || null;
  });
  const isContainerized = !!(sdkSession?.containerId || bridgeSession?.is_containerized);

  const openQuickTerminal = (opts: { target: "host" | "docker"; cwd: string; containerId?: string }) => {
    const key = `${opts.target}:${opts.cwd}:${opts.containerId || ""}`;
    const existing = terminalTabs.find((t) => t.id === key);
    if (existing) {
      setActiveTerminalTabId(existing.id);
      setTerminalPanelOpen(true);
      return;
    }

    const next: QuickTerminalTab = {
      id: key,
      label: opts.target === "docker" ? "Docker" : "Machine",
      cwd: opts.cwd,
      containerId: opts.containerId,
    };
    setTerminalTabs((tabs) => [...tabs, next]);
    setActiveTerminalTabId(next.id);
    setTerminalPanelOpen(true);
  };

  const closeTerminalTab = (tabId: string) => {
    setTerminalTabs((tabs) => {
      const next = tabs.filter((t) => t.id !== tabId);
      if (activeTerminalTabId === tabId) {
        setActiveTerminalTabId(next[0]?.id || null);
      }
      if (next.length === 0) {
        setTerminalPanelOpen(false);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!currentSessionId) {
      setTerminalTabs([]);
      setActiveTerminalTabId(null);
      setTerminalPanelOpen(false);
    }
  }, [currentSessionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "j") return;
      if (!isSessionView || !cwd) return;
      event.preventDefault();
      openQuickTerminal({ target: "host", cwd });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSessionView, cwd, terminalTabs]);

  const isConnected = currentSessionId ? (cliConnected.get(currentSessionId) ?? false) : false;
  const status = currentSessionId ? (sessionStatus.get(currentSessionId) ?? null) : null;
  const isAssistant = !!(currentSessionId && assistantSessionId && currentSessionId === assistantSessionId);
  const sessionName = currentSessionId
    ? isAssistant
      ? "Companion"
      : (sessionNames?.get(currentSessionId) ||
        sdkSessions.find((s) => s.sessionId === currentSessionId)?.name ||
        `Session ${currentSessionId.slice(0, 8)}`)
    : null;

  return (
    <header className="relative shrink-0 flex items-center justify-between px-2 sm:px-4 py-2 sm:py-2.5 bg-cc-card border-b border-cc-border">
      <div className="flex items-center gap-3">
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="flex items-center justify-center w-7 h-7 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
          </svg>
        </button>

        {/* Connection status */}
        {currentSessionId && (
          <div className="flex items-center gap-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isConnected ? "bg-cc-success" : "bg-cc-muted opacity-40"
              }`}
            />
            {sessionName && (
              <span className="text-[11px] font-medium text-cc-fg max-w-[9rem] sm:max-w-none truncate flex items-center gap-1" title={sessionName}>
                {isAssistant && (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-primary shrink-0">
                    <path d="M8 0l1.5 5.2L14.8 4 9.8 6.5 14 11l-5.2-1.5L8 16l-1-6.5L1.2 11l5-4.5L1.2 4l5.3 1.2z" />
                  </svg>
                )}
                {sessionName}
              </span>
            )}
            {cwd && isSessionView && (
              <button
                onClick={() => openQuickTerminal({ target: "host", cwd })}
                className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium border transition-colors cursor-pointer ${
                  terminalPanelOpen
                    ? "bg-cc-active text-cc-primary border-cc-primary/30"
                    : "bg-cc-hover text-cc-muted border-cc-border hover:text-cc-fg"
                }`}
                title="Quick terminal (Ctrl/Cmd+J)"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  <path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zm3.2 2.2a.7.7 0 00-.99.99L5.82 8.3 4.21 9.91a.7.7 0 00.99.99l2.1-2.1a.7.7 0 000-.99L5.2 5.7zm3.6 4.1h2.4a.7.7 0 000-1.4H8.8a.7.7 0 000 1.4z" />
                </svg>
                Terminal
              </button>
            )}
            {!isConnected && (
              <button
                onClick={() => currentSessionId && api.relaunchSession(currentSessionId).catch(console.error)}
                className="text-[11px] text-cc-warning hover:text-cc-warning/80 font-medium cursor-pointer hidden sm:inline"
              >
                Reconnect
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right side */}
      {currentSessionId && isSessionView && (
        <div className="flex items-center gap-2 sm:gap-3 text-[12px] text-cc-muted">
          {status === "compacting" && (
            <span className="text-cc-warning font-medium animate-pulse">Compacting...</span>
          )}

          {status === "running" && (
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cc-primary animate-[pulse-dot_1s_ease-in-out_infinite]" />
              <span className="text-cc-primary font-medium">Thinking</span>
            </div>
          )}

          {/* Chat / Editor tab toggle — hidden for assistant (no git/diffs) */}
          {!isAssistant && (
            <div className="flex items-center bg-cc-hover rounded-lg p-0.5">
              <button
                onClick={() => setActiveTab("chat")}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                  activeTab === "chat"
                    ? "bg-cc-card text-cc-fg shadow-sm"
                    : "text-cc-muted hover:text-cc-fg"
                }`}
              >
                Chat
              </button>
              <button
                onClick={() => setActiveTab("diff")}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                  activeTab === "diff"
                    ? "bg-cc-card text-cc-fg shadow-sm"
                    : "text-cc-muted hover:text-cc-fg"
                }`}
              >
                Diffs
                {changedFilesCount > 0 && (
                  <span className="text-[9px] bg-cc-warning text-white rounded-full w-4 h-4 flex items-center justify-center font-semibold leading-none">
                    {changedFilesCount}
                  </span>
                )}
              </button>
            </div>
          )}

          {/* CLAUDE.md editor — hidden for assistant */}
          {cwd && !isAssistant && (
            <button
              onClick={() => setClaudeMdOpen(true)}
              className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
                claudeMdOpen
                  ? "text-cc-primary bg-cc-active"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
              title="Edit CLAUDE.md"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1zM6.5 7a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
              </svg>
            </button>
          )}

          <button
            onClick={() => setTaskPanelOpen(!taskPanelOpen)}
            className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
              taskPanelOpen
                ? "text-cc-primary bg-cc-active"
                : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
            title="Toggle session panel"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V4a2 2 0 00-2-2H6zm1 3a1 1 0 000 2h6a1 1 0 100-2H7zm0 4a1 1 0 000 2h6a1 1 0 100-2H7zm0 4a1 1 0 000 2h4a1 1 0 100-2H7z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}

      {/* CLAUDE.md editor modal */}
      {cwd && (
        <ClaudeMdEditor
          cwd={cwd}
          open={claudeMdOpen}
          onClose={() => setClaudeMdOpen(false)}
        />
      )}

      {currentSessionId && isSessionView && terminalPanelOpen && terminalTabs.length > 0 && (
        <div className="absolute left-2 right-2 top-[calc(100%+8px)] z-50 rounded-xl border border-cc-border bg-cc-card shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-2 py-1.5 border-b border-cc-border bg-cc-sidebar">
            <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto">
              {terminalTabs.map((tab) => (
                <div
                  key={tab.id}
                  onClick={() => setActiveTerminalTabId(tab.id)}
                  className={`group inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                    activeTerminalTabId === tab.id
                      ? "text-cc-fg bg-cc-card border-cc-border"
                      : "text-cc-muted bg-transparent border-transparent hover:text-cc-fg hover:bg-cc-hover"
                  }`}
                  title={tab.cwd}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActiveTerminalTabId(tab.id);
                    }
                  }}
                >
                  <span>{tab.label}</span>
                  <span className="font-mono-code text-[10px] opacity-80 max-w-[220px] truncate">{tab.cwd}</span>
                  <button
                    type="button"
                    aria-label={`Close ${tab.label} terminal tab`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerminalTab(tab.id);
                    }}
                    className="w-4 h-4 rounded-sm flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-1">
              {cwd && (
                <button
                  onClick={() => openQuickTerminal({ target: "host", cwd })}
                  className="px-2 py-1 rounded-md text-[11px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                  title="Open terminal on machine"
                >
                  + Machine
                </button>
              )}
              {isContainerized && sdkSession?.containerId && (
                <button
                  onClick={() => openQuickTerminal({ target: "docker", cwd: "/workspace", containerId: sdkSession.containerId })}
                  className="px-2 py-1 rounded-md text-[11px] text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 transition-colors cursor-pointer"
                  title="Open terminal in session container"
                >
                  + Docker
                </button>
              )}
              <button
                onClick={() => setTerminalPanelOpen(false)}
                className="ml-1 px-2 py-1 rounded-md text-[11px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>

          <div className="h-[340px] bg-cc-bg p-2">
            {terminalTabs.map((tab) => (
              <div key={tab.id} className={activeTerminalTabId === tab.id ? "h-full" : "hidden"}>
                <TerminalView
                  cwd={tab.cwd}
                  containerId={tab.containerId}
                  title={tab.containerId ? `docker:${tab.cwd}` : tab.cwd}
                  embedded
                  visible={activeTerminalTabId === tab.id}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}
