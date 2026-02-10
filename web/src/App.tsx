import { useEffect, useSyncExternalStore } from "react";
import { useStore } from "./store.js";
import { connectSession, disconnectSession } from "./ws.js";
import { api } from "./api.js";
import { Sidebar } from "./components/Sidebar.js";
import { ChatView } from "./components/ChatView.js";
import { TopBar } from "./components/TopBar.js";
import { HomePage } from "./components/HomePage.js";
import { TaskPanel } from "./components/TaskPanel.js";
import { EditorPanel } from "./components/EditorPanel.js";
import { Playground } from "./components/Playground.js";

function useHash() {
  return useSyncExternalStore(
    (cb) => { window.addEventListener("hashchange", cb); return () => window.removeEventListener("hashchange", cb); },
    () => window.location.hash,
  );
}

export default function App() {
  const darkMode = useStore((s) => s.darkMode);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const homeResetKey = useStore((s) => s.homeResetKey);
  const activeTab = useStore((s) => s.activeTab);
  const hash = useHash();

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  // Auto-connect to restored session on mount
  useEffect(() => {
    const restoredId = useStore.getState().currentSessionId;
    if (restoredId) {
      connectSession(restoredId);
    }
  }, []);

  // Helper functions for keyboard shortcuts
  function archiveCurrentSession() {
    const { currentSessionId } = useStore.getState();
    if (!currentSessionId) return;
    disconnectSession(currentSessionId);
    api.archiveSession(currentSessionId);
    useStore.getState().newSession();
  }

  function navigateSession(direction: number) {
    const state = useStore.getState();
    const { currentSessionId } = state;
    // Get non-archived sessions sorted by creation time
    const sessions = state.sdkSessions
      .filter(s => !s.archived)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    if (sessions.length === 0) return;

    const currentIndex = sessions.findIndex(s => s.sessionId === currentSessionId);
    const nextIndex = currentIndex === -1
      ? 0
      : (currentIndex + direction + sessions.length) % sessions.length;

    const nextSession = sessions[nextIndex];
    if (nextSession && nextSession.sessionId !== currentSessionId) {
      if (currentSessionId) disconnectSession(currentSessionId);
      state.setCurrentSession(nextSession.sessionId);
      connectSession(nextSession.sessionId);
    }
  }

  // Keyboard shortcuts and mouse navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInputFocused = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const mod = isMac ? e.metaKey : e.ctrlKey;

      // Ctrl/Cmd+T — New session (skip when typing in inputs)
      if (mod && e.key === "t" && !e.shiftKey && !e.altKey) {
        if (isInputFocused) return;
        e.preventDefault();
        useStore.getState().newSession();
        return;
      }

      // Alt+X — Archive current session
      if (e.altKey && e.key === "x" && !mod && !e.shiftKey) {
        e.preventDefault();
        archiveCurrentSession();
        return;
      }

      // Ctrl+Delete — Archive current session
      if (mod && e.key === "Delete" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        archiveCurrentSession();
        return;
      }

      // Alt+Ctrl/Cmd+PageUp — Previous session
      if (e.altKey && mod && e.key === "PageUp") {
        e.preventDefault();
        navigateSession(-1);
        return;
      }

      // Alt+Ctrl/Cmd+PageDown — Next session
      if (e.altKey && mod && e.key === "PageDown") {
        e.preventDefault();
        navigateSession(1);
        return;
      }
    };

    // Mouse back/forward buttons for session navigation
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 3) { // Back button
        e.preventDefault();
        navigateSession(-1);
      } else if (e.button === 4) { // Forward button
        e.preventDefault();
        navigateSession(1);
      }
    };

    // Middle-click to archive
    const handleAuxClick = (e: MouseEvent) => {
      if (e.button === 1) { // Middle click
        // Only in sidebar area
        const sidebar = (e.target as HTMLElement).closest('[data-sidebar]');
        if (sidebar) {
          e.preventDefault();
          archiveCurrentSession();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("auxclick", handleAuxClick);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("auxclick", handleAuxClick);
    };
  }, []);

  if (hash === "#/playground") {
    return <Playground />;
  }

  return (
    <div className="h-[100dvh] flex font-sans-ui bg-cc-bg text-cc-fg antialiased">
      {/* Mobile overlay backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-30 md:hidden"
          onClick={() => useStore.getState().setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — overlay on mobile, inline on desktop */}
      <div
        className={`
          fixed md:relative z-40 md:z-auto
          h-full shrink-0 transition-all duration-200
          ${sidebarOpen ? "w-[260px] translate-x-0" : "w-0 -translate-x-full md:translate-x-0"}
          overflow-hidden
        `}
      >
        <Sidebar />
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar />
        <div className="flex-1 overflow-hidden relative">
          {/* Chat tab — visible when activeTab is "chat" or no session */}
          <div className={`absolute inset-0 ${activeTab === "chat" || !currentSessionId ? "" : "hidden"}`}>
            {currentSessionId ? (
              <ChatView sessionId={currentSessionId} />
            ) : (
              <HomePage key={homeResetKey} />
            )}
          </div>

          {/* Editor tab */}
          {currentSessionId && activeTab === "editor" && (
            <div className="absolute inset-0">
              <EditorPanel sessionId={currentSessionId} />
            </div>
          )}
        </div>
      </div>

      {/* Task panel — overlay on mobile, inline on desktop */}
      {currentSessionId && (
        <>
          {/* Mobile overlay backdrop */}
          {taskPanelOpen && (
            <div
              className="fixed inset-0 bg-black/30 z-30 lg:hidden"
              onClick={() => useStore.getState().setTaskPanelOpen(false)}
            />
          )}

          <div
            className={`
              fixed lg:relative z-40 lg:z-auto right-0 top-0
              h-full shrink-0 transition-all duration-200
              ${taskPanelOpen ? "w-[280px] translate-x-0" : "w-0 translate-x-full lg:translate-x-0"}
              overflow-hidden
            `}
          >
            <TaskPanel sessionId={currentSessionId} />
          </div>
        </>
      )}
    </div>
  );
}
