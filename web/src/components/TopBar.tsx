import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useStore } from "../store.js";
import { parseHash } from "../utils/routing.js";

type WorkspaceTab = "chat" | "diff" | "terminal" | "editor";

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
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);
  const activeTab = useStore((s) => s.activeTab);
  const editorTabEnabled = useStore((s) => s.editorTabEnabled);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const markChatTabReentry = useStore((s) => s.markChatTabReentry);
  const quickTerminalOpen = useStore((s) => s.quickTerminalOpen);
  const quickTerminalTabs = useStore((s) => s.quickTerminalTabs);
  const openQuickTerminal = useStore((s) => s.openQuickTerminal);
  const resetQuickTerminal = useStore((s) => s.resetQuickTerminal);
  const changedFilesCount = useStore((s) =>
    currentSessionId ? (s.gitChangedFilesCount.get(currentSessionId) ?? 0) : 0
  );

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
  const defaultTerminalOpts = useMemo(() => {
    if (sdkSession?.containerId) {
      return { target: "docker" as const, cwd: "/workspace", containerId: sdkSession.containerId };
    }
    return { target: "host" as const, cwd: cwd || "" };
  }, [cwd, sdkSession?.containerId]);
  const terminalButtonTitle = !cwd
    ? "Terminal unavailable while session is reconnecting"
    : sdkSession?.containerId || bridgeSession?.is_containerized
      ? "Open terminal in session container (Ctrl/Cmd+J)"
      : "Quick terminal (Ctrl/Cmd+J)";
  const status = currentSessionId ? (sessionStatus.get(currentSessionId) ?? null) : null;
  const isConnected = currentSessionId ? (cliConnected.get(currentSessionId) ?? false) : false;
  const sessionName = currentSessionId
    ? (sessionNames?.get(currentSessionId) ||
      sdkSessions.find((s) => s.sessionId === currentSessionId)?.name ||
      `Session ${currentSessionId.slice(0, 8)}`)
    : null;
  const showWorkspaceControls = !!(currentSessionId && isSessionView);
  const showContextToggle = route.page === "session" && !!currentSessionId;
  const workspaceTabs = useMemo(() => {
    const tabs: WorkspaceTab[] = ["chat", "diff", "terminal"];
    if (editorTabEnabled) tabs.push("editor");
    return tabs;
  }, [editorTabEnabled]);

  const activateWorkspaceTab = (tab: WorkspaceTab) => {
    if (tab === "terminal") {
      if (!cwd) return;
      if (!quickTerminalOpen || quickTerminalTabs.length === 0) {
        openQuickTerminal({ ...defaultTerminalOpts, reuseIfExists: true });
      }
      setActiveTab("terminal");
      return;
    }

    if (tab === "editor") {
      if (!cwd) return;
      setActiveTab("editor");
      return;
    }

    if (tab === "chat" && activeTab !== "chat" && currentSessionId) {
      markChatTabReentry(currentSessionId);
    }
    setActiveTab(tab);
  };

  useEffect(() => {
    if (!currentSessionId) {
      resetQuickTerminal();
    }
  }, [currentSessionId, resetQuickTerminal]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "j") return;
      if (!showWorkspaceControls) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      const currentIndex = Math.max(0, workspaceTabs.indexOf(activeTab));
      const direction = event.shiftKey ? -1 : 1;
      const nextIndex = (currentIndex + direction + workspaceTabs.length) % workspaceTabs.length;
      activateWorkspaceTab(workspaceTabs[nextIndex]);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showWorkspaceControls, workspaceTabs, activeTab, cwd, quickTerminalOpen, quickTerminalTabs.length, openQuickTerminal, defaultTerminalOpts, setActiveTab, markChatTabReentry, currentSessionId]);

  return (
    <header className="relative shrink-0 h-11 px-4 bg-cc-bg border-b border-cc-separator">
      <div className="h-full flex items-center gap-1 min-w-0">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="flex items-center justify-center w-7 h-7 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
          aria-label="Toggle sidebar"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[15px] h-[15px]">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v18H3V3z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 3v18" />
          </svg>
        </button>

        {showWorkspaceControls && (
          <div className="flex-1 flex items-center justify-center gap-0.5 min-w-0">
              <button
                onClick={() => activateWorkspaceTab("chat")}
                className={`h-full px-3 text-[12px] font-medium transition-colors cursor-pointer min-w-0 max-w-[44vw] sm:max-w-[30vw] truncate flex items-center gap-1.5 border-b-[1.5px] ${
                  activeTab === "chat"
                    ? "text-cc-fg border-cc-primary"
                    : "text-cc-muted hover:text-cc-fg border-transparent"
                }`}
                title={sessionName || "Session"}
                aria-label="Session tab"
              >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    !isConnected
                      ? "bg-cc-muted opacity-45"
                      : status === "running"
                        ? "bg-cc-primary"
                        : status === "compacting"
                          ? "bg-cc-warning"
                          : "bg-cc-success"
                  }`} />
                  <span className="truncate">{sessionName || "Session"}</span>
              </button>
              <button
                onClick={() => activateWorkspaceTab("diff")}
                className={`h-full px-3 text-[12px] font-medium transition-colors cursor-pointer flex items-center gap-1.5 border-b-[1.5px] ${
                  activeTab === "diff"
                    ? "text-cc-fg border-cc-primary"
                    : "text-cc-muted hover:text-cc-fg border-transparent"
                }`}
                aria-label="Diffs tab"
              >
                Diffs
                {changedFilesCount > 0 && (
                  <span className="text-[9px] rounded-full min-w-[15px] h-[15px] px-1 flex items-center justify-center font-semibold leading-none bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300">
                    {changedFilesCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => activateWorkspaceTab("terminal")}
                disabled={!cwd}
                className={`h-full px-3 text-[12px] font-medium transition-colors flex items-center border-b-[1.5px] ${
                  !cwd
                    ? "text-cc-muted/50 border-transparent cursor-not-allowed"
                    : activeTab === "terminal"
                      ? "text-cc-fg border-cc-primary cursor-pointer"
                      : "text-cc-muted hover:text-cc-fg border-transparent cursor-pointer"
                }`}
                title={terminalButtonTitle}
                aria-label="Shell tab"
              >
                Shell
              </button>
              {editorTabEnabled && (
                <button
                  onClick={() => activateWorkspaceTab("editor")}
                  disabled={!cwd}
                  className={`h-full px-3 text-[12px] font-medium transition-colors flex items-center border-b-[1.5px] ${
                    !cwd
                      ? "text-cc-muted/50 border-transparent cursor-not-allowed"
                      : activeTab === "editor"
                        ? "text-cc-fg border-cc-primary cursor-pointer"
                        : "text-cc-muted hover:text-cc-fg border-transparent cursor-pointer"
                  }`}
                  title={!cwd ? "Editor unavailable while session is reconnecting" : "Editor"}
                  aria-label="Editor tab"
                >
                  Editor
                </button>
              )}
          </div>
        )}

        <div className="flex items-center gap-0.5 shrink-0">
          {showContextToggle && (
            <button
              onClick={() => setTaskPanelOpen(!taskPanelOpen)}
              className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors cursor-pointer ${
                taskPanelOpen
                  ? "text-cc-primary bg-cc-active"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
              title="Toggle context panel"
              aria-label="Toggle context panel"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[15px] h-[15px]">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v18H3V3z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 3v18" />
              </svg>
            </button>
          )}
        </div>
      </div>

    </header>
  );
}
