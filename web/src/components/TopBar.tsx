import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStore } from "../store.js";
import { ClaudeMdEditor } from "./ClaudeMdEditor.js";
import { parseHash } from "../utils/routing.js";

function fallbackTabSurfaceColor(tab: "chat" | "diff" | "terminal"): string {
  // Fallback semantic mapping when sampling is unavailable (e.g. during SSR/jsdom tests).
  return tab === "terminal" ? "var(--cc-card)" : "var(--cc-bg)";
}

function getSurfaceColorBelowTab(tabEl: HTMLElement | null, activeTab: "chat" | "diff" | "terminal"): string {
  if (!tabEl || typeof window === "undefined" || typeof document === "undefined") {
    return fallbackTabSurfaceColor(activeTab);
  }

  const rect = tabEl.getBoundingClientRect();
  const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
  const y = Math.max(0, Math.min(window.innerHeight - 1, rect.bottom + 2));

  let el: HTMLElement | null = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el) {
    const bg = window.getComputedStyle(el).backgroundColor;
    if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return bg;
    el = el.parentElement;
  }

  return fallbackTabSurfaceColor(activeTab);
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
  const markChatTabReentry = useStore((s) => s.markChatTabReentry);
  const [claudeMdOpen, setClaudeMdOpen] = useState(false);
  const [activeTabSurfaceColor, setActiveTabSurfaceColor] = useState<string>(fallbackTabSurfaceColor(activeTab));
  const sessionTabRef = useRef<HTMLButtonElement>(null);
  const diffTabRef = useRef<HTMLButtonElement>(null);
  const shellTabRef = useRef<HTMLButtonElement>(null);
  const quickTerminalOpen = useStore((s) => s.quickTerminalOpen);
  const quickTerminalTabs = useStore((s) => s.quickTerminalTabs);
  const quickTerminalPlacement = useStore((s) => s.quickTerminalPlacement);
  const openQuickTerminal = useStore((s) => s.openQuickTerminal);
  const resetQuickTerminal = useStore((s) => s.resetQuickTerminal);
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
  const isAssistant = !!(currentSessionId && assistantSessionId && currentSessionId === assistantSessionId);
  const sessionName = currentSessionId
    ? isAssistant
      ? "Companion"
      : (sessionNames?.get(currentSessionId) ||
        sdkSessions.find((s) => s.sessionId === currentSessionId)?.name ||
        `Session ${currentSessionId.slice(0, 8)}`)
    : null;
  const showWorkspaceControls = !!(currentSessionId && isSessionView);
  const workspaceTabs = useMemo(() => {
    const tabs: Array<"chat" | "diff" | "terminal"> = ["chat"];
    if (!isAssistant) tabs.push("diff");
    tabs.push("terminal");
    return tabs;
  }, [isAssistant]);

  const activateWorkspaceTab = (tab: "chat" | "diff" | "terminal") => {
    if (tab === "terminal") {
      if (!cwd) return;
      if (!quickTerminalOpen || quickTerminalTabs.length === 0) {
        openQuickTerminal({ ...defaultTerminalOpts, reuseIfExists: true });
      }
      setActiveTab("terminal");
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

  useEffect(() => {
    if (!showWorkspaceControls) return;
    const currentTabEl = activeTab === "chat"
      ? sessionTabRef.current
      : activeTab === "diff"
        ? diffTabRef.current
        : shellTabRef.current;
    const update = () => setActiveTabSurfaceColor(getSurfaceColorBelowTab(currentTabEl, activeTab));
    const raf = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(raf);
  }, [showWorkspaceControls, activeTab, quickTerminalOpen, quickTerminalPlacement, taskPanelOpen]);

  useEffect(() => {
    if (!showWorkspaceControls) return;
    const onResize = () => {
      const currentTabEl = activeTab === "chat"
        ? sessionTabRef.current
        : activeTab === "diff"
          ? diffTabRef.current
          : shellTabRef.current;
      setActiveTabSurfaceColor(getSurfaceColorBelowTab(currentTabEl, activeTab));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [showWorkspaceControls, activeTab]);

  return (
    <header className={`relative shrink-0 h-12 px-2 sm:px-4 bg-cc-sidebar ${showWorkspaceControls ? "" : "border-b border-cc-border"}`}>
      <div className="h-full flex items-end gap-2 min-w-0">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="mb-1 flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
          aria-label="Toggle sidebar"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
          </svg>
        </button>

        {showWorkspaceControls && (
          <div className="flex-1 min-w-0">
            <div className="flex items-end gap-1 min-w-0">
              <button
                ref={sessionTabRef}
                onClick={() => activateWorkspaceTab("chat")}
                className={`h-9 px-3.5 border text-[12px] font-semibold transition-colors cursor-pointer min-w-0 max-w-[44vw] sm:max-w-[30vw] truncate ${
                  activeTab === "chat"
                    ? "relative z-10 h-9 -mb-px text-cc-fg border-cc-border/80 border-b-transparent rounded-[14px_14px_0_0]"
                    : "h-8 mb-px bg-transparent text-cc-muted border-transparent rounded-[8px_8px_0_0] hover:bg-cc-hover/70 hover:text-cc-fg"
                }`}
                style={activeTab === "chat" ? { backgroundColor: activeTabSurfaceColor } : undefined}
                title={sessionName || "Session"}
                aria-label="Session tab"
              >
                <span className="inline-flex items-center gap-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    status === "running" ? "bg-cc-primary" : status === "compacting" ? "bg-cc-warning" : "bg-cc-success"
                  }`} />
                  <span className="truncate">{sessionName || "Session"}</span>
                </span>
              </button>
              {!isAssistant && (
                <button
                  ref={diffTabRef}
                  onClick={() => activateWorkspaceTab("diff")}
                  className={`px-3.5 border text-[12px] font-semibold transition-colors cursor-pointer flex items-center gap-1.5 ${
                    activeTab === "diff"
                      ? "relative z-10 h-9 -mb-px text-cc-fg border-cc-border/80 border-b-transparent rounded-[14px_14px_0_0]"
                      : "h-8 mb-px bg-transparent text-cc-muted border-transparent rounded-[8px_8px_0_0] hover:bg-cc-hover/70 hover:text-cc-fg"
                  }`}
                  style={activeTab === "diff" ? { backgroundColor: activeTabSurfaceColor } : undefined}
                  aria-label="Diffs tab"
                >
                  Diffs
                  {changedFilesCount > 0 && (
                    <span className="text-[10px] bg-cc-warning text-white rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center font-semibold leading-none">
                      {changedFilesCount}
                    </span>
                  )}
                </button>
              )}
              <button
                ref={shellTabRef}
                onClick={() => activateWorkspaceTab("terminal")}
                disabled={!cwd}
                className={`px-3.5 border text-[12px] font-semibold transition-colors ${
                  !cwd
                    ? "h-8 mb-px bg-transparent text-cc-muted/50 border-transparent rounded-[8px_8px_0_0] cursor-not-allowed"
                    : activeTab === "terminal"
                      ? "relative z-10 h-9 -mb-px text-cc-fg border-cc-border/80 border-b-transparent rounded-[14px_14px_0_0] cursor-pointer"
                      : "h-8 mb-px bg-transparent text-cc-muted border-transparent rounded-[8px_8px_0_0] hover:bg-cc-hover/70 hover:text-cc-fg cursor-pointer"
                }`}
                style={activeTab === "terminal" ? { backgroundColor: activeTabSurfaceColor } : undefined}
                title={terminalButtonTitle}
                aria-label="Shell tab"
              >
                Shell
              </button>
              <div
                className="hidden lg:flex h-8 mb-px items-center pl-2"
                title="Switch tabs with Ctrl/Cmd + J"
                aria-label="Tab switch shortcut"
              >
                <span className="inline-flex items-center gap-1 text-[10px] text-cc-muted/60">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="w-3 h-3">
                    <rect x="1.75" y="3" width="12.5" height="10" rx="1.75" />
                    <path d="M4.5 6.5h7M4.5 9h5.5" strokeLinecap="round" />
                  </svg>
                  <span className="font-mono-code text-[10px] leading-none">J</span>
                </span>
              </div>
            </div>
          </div>
        )}

        <div className="mb-1 flex items-center gap-1.5 shrink-0">
          {cwd && !isAssistant && (
            <button
              onClick={() => setClaudeMdOpen(true)}
              className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors cursor-pointer ${
                claudeMdOpen
                  ? "text-cc-primary bg-cc-active"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
              title="Edit CLAUDE.md"
              aria-label="Edit CLAUDE.md"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1zM6.5 7a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
              </svg>
            </button>
          )}
          <button
            onClick={() => setTaskPanelOpen(!taskPanelOpen)}
            className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg transition-colors cursor-pointer ${
              taskPanelOpen
                ? "text-cc-primary bg-cc-active"
                : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
            title="Toggle context panel"
            aria-label="Toggle context panel"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V4a2 2 0 00-2-2H6zm1 3a1 1 0 000 2h6a1 1 0 100-2H7zm0 4a1 1 0 000 2h6a1 1 0 100-2H7zm0 4a1 1 0 000 2h4a1 1 0 100-2H7z" clipRule="evenodd" />
            </svg>
            <span className="hidden sm:inline text-[11px] font-medium">Context</span>
          </button>
        </div>
      </div>

      {/* CLAUDE.md editor modal */}
      {cwd && (
        <ClaudeMdEditor
          cwd={cwd}
          open={claudeMdOpen}
          onClose={() => setClaudeMdOpen(false)}
        />
      )}
    </header>
  );
}
