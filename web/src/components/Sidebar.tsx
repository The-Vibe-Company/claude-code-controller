import { useState, useEffect, useCallback } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { connectSession, disconnectSession } from "../ws.js";
import { EnvManager } from "./EnvManager.js";
import { SessionItem } from "./SessionItem.js";
import { ProjectGroup } from "./ProjectGroup.js";
import { groupSessionsByProject } from "../utils/project-grouping.js";
import type { SidebarSession } from "../types.js";

export function Sidebar() {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showEnvManager, setShowEnvManager] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
  const sessions = useStore((s) => s.sessions);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const darkMode = useStore((s) => s.darkMode);
  const toggleDarkMode = useStore((s) => s.toggleDarkMode);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const removeSession = useStore((s) => s.removeSession);
  const sessionNames = useStore((s) => s.sessionNames);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const collapsedProjects = useStore((s) => s.collapsedProjects);
  const toggleProjectCollapsed = useStore((s) => s.toggleProjectCollapsed);
  const projectNames = useStore((s) => s.projectNames);
  const setProjectName = useStore((s) => s.setProjectName);

  // Poll for SDK sessions on mount
  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const list = await api.listSessions();
        if (active) {
          useStore.getState().setSdkSessions(list);
          // Hydrate session names from server (server is source of truth for auto-generated names)
          const store = useStore.getState();
          for (const s of list) {
            if (s.name && (!store.sessionNames.has(s.sessionId) || /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(store.sessionNames.get(s.sessionId)!))) {
              store.setSessionName(s.sessionId, s.name);
            }
          }
        }
      } catch {
        // server not ready
      }
      // Also fetch project names
      try {
        const projects = await api.listProjects();
        if (active) {
          const nameMap: Record<string, string> = {};
          for (const p of projects) {
            if (p.name) nameMap[p.key] = p.name;
          }
          useStore.getState().setProjectNames(nameMap);
        }
      } catch {
        // non-critical, project names may just not be loaded
      }
    }
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  function handleSelectSession(sessionId: string) {
    if (currentSessionId === sessionId) return;
    // Disconnect from old session, connect to new
    if (currentSessionId) {
      disconnectSession(currentSessionId);
    }
    setCurrentSession(sessionId);
    connectSession(sessionId);
    // Close sidebar on mobile
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function handleNewSession() {
    if (currentSessionId) {
      disconnectSession(currentSessionId);
    }
    useStore.getState().newSession();
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function confirmRename() {
    if (editingSessionId && editingName.trim()) {
      useStore.getState().setSessionName(editingSessionId, editingName.trim());
      api.renameSession(editingSessionId, editingName.trim()).catch(() => {});
    }
    setEditingSessionId(null);
    setEditingName("");
  }

  function cancelRename() {
    setEditingSessionId(null);
    setEditingName("");
  }

  const handleDeleteSession = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    try {
      disconnectSession(sessionId);
      await api.deleteSession(sessionId);
    } catch {
      // best-effort
    }
    removeSession(sessionId);
  }, [removeSession]);

  const handleArchiveSession = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    // Check if session uses a worktree — if so, ask for confirmation
    const sdkInfo = sdkSessions.find((s) => s.sessionId === sessionId);
    const bridgeState = sessions.get(sessionId);
    const isWorktree = bridgeState?.is_worktree || sdkInfo?.isWorktree || false;
    if (isWorktree) {
      setConfirmArchiveId(sessionId);
      return;
    }
    doArchive(sessionId);
  }, [sdkSessions, sessions]);

  const doArchive = useCallback(async (sessionId: string, force?: boolean) => {
    try {
      disconnectSession(sessionId);
      await api.archiveSession(sessionId, force ? { force: true } : undefined);
    } catch {
      // best-effort
    }
    if (useStore.getState().currentSessionId === sessionId) {
      useStore.getState().newSession();
    }
    try {
      const list = await api.listSessions();
      useStore.getState().setSdkSessions(list);
    } catch {
      // best-effort
    }
  }, []);

  const confirmArchive = useCallback(() => {
    if (confirmArchiveId) {
      doArchive(confirmArchiveId, true);
      setConfirmArchiveId(null);
    }
  }, [confirmArchiveId, doArchive]);

  const cancelArchive = useCallback(() => {
    setConfirmArchiveId(null);
  }, []);

  const handleUnarchiveSession = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    try {
      await api.unarchiveSession(sessionId);
    } catch {
      // best-effort
    }
    try {
      const list = await api.listSessions();
      useStore.getState().setSdkSessions(list);
    } catch {
      // best-effort
    }
  }, []);

  // Combine sessions from WsBridge state + SDK sessions list
  const allSessionIds = new Set<string>();
  for (const id of sessions.keys()) allSessionIds.add(id);
  for (const s of sdkSessions) allSessionIds.add(s.sessionId);

  const allSessionList = Array.from(allSessionIds).map((id) => {
    const bridgeState = sessions.get(id);
    const sdkInfo = sdkSessions.find((s) => s.sessionId === id);
    return {
      id,
      model: bridgeState?.model || sdkInfo?.model || "",
      cwd: bridgeState?.cwd || sdkInfo?.cwd || "",
      gitBranch: bridgeState?.git_branch || "",
      isWorktree: bridgeState?.is_worktree || sdkInfo?.isWorktree || false,
      gitAhead: bridgeState?.git_ahead || 0,
      gitBehind: bridgeState?.git_behind || 0,
      linesAdded: bridgeState?.total_lines_added || 0,
      linesRemoved: bridgeState?.total_lines_removed || 0,
      isConnected: cliConnected.get(id) ?? false,
      status: sessionStatus.get(id) ?? null,
      sdkState: sdkInfo?.state ?? null,
      createdAt: sdkInfo?.createdAt ?? 0,
      archived: sdkInfo?.archived ?? false,
      projectKey: sdkInfo?.projectKey,
    };
  }).sort((a, b) => b.createdAt - a.createdAt);

  const activeSessions = allSessionList.filter((s) => !s.archived);
  const archivedSessions = allSessionList.filter((s) => s.archived);

  // Build cost map for project grouping
  const sessionCosts = new Map<string, number>();
  for (const [id, state] of sessions) {
    sessionCosts.set(id, state.total_cost_usd ?? 0);
  }

  const activeProjects = groupSessionsByProject(
    activeSessions as SidebarSession[],
    projectNames,
    sessionCosts,
  );

  const archivedProjects = groupSessionsByProject(
    archivedSessions as SidebarSession[],
    projectNames,
    sessionCosts,
  );

  function renderSession(s: typeof allSessionList[number], options?: { isArchived?: boolean }) {
    const name = sessionNames.get(s.id);
    const permCount = pendingPermissions.get(s.id)?.size ?? 0;
    const isActive = currentSessionId === s.id;
    const isEditing = editingSessionId === s.id;
    const archived = options?.isArchived;

    return (
      <SessionItem
        key={s.id}
        session={s}
        isActive={isActive}
        sessionName={name}
        isEditing={isEditing}
        editingName={editingName}
        permCount={permCount}
        isArchived={archived}
        onSelect={() => handleSelectSession(s.id)}
        onStartRename={(currentName) => {
          setEditingSessionId(s.id);
          setEditingName(currentName);
        }}
        onCancelRename={() => cancelRename()}
        onConfirmRename={() => confirmRename()}
        onEditingNameChange={setEditingName}
        onArchive={() => {
          const fakeEvent = { stopPropagation: () => {} } as React.MouseEvent;
          handleArchiveSession(fakeEvent, s.id);
        }}
        onUnarchive={archived ? () => {
          const fakeEvent = { stopPropagation: () => {} } as React.MouseEvent;
          handleUnarchiveSession(fakeEvent, s.id);
        } : undefined}
        onDelete={archived ? () => {
          const fakeEvent = { stopPropagation: () => {} } as React.MouseEvent;
          handleDeleteSession(fakeEvent, s.id);
        } : undefined}
      />
    );
  }

  return (
    <aside data-sidebar className="w-[260px] h-full flex flex-col bg-cc-sidebar border-r border-cc-border">
      {/* Header */}
      <div className="p-4 pb-3">
        <div className="flex items-center gap-2 mb-4">
          <img src="/logo.svg" alt="" className="w-7 h-7" />
          <span className="text-sm font-semibold text-cc-fg tracking-tight">The Vibe Companion</span>
        </div>

        <button
          onClick={handleNewSession}
          className="w-full py-2 px-3 text-sm font-medium rounded-[10px] bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors duration-150 flex items-center justify-center gap-1.5 cursor-pointer"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
            <path d="M8 3v10M3 8h10" />
          </svg>
          New Session
        </button>
      </div>

      {/* Worktree archive confirmation */}
      {confirmArchiveId && (
        <div className="mx-2 mb-1 p-2.5 rounded-[10px] bg-amber-500/10 border border-amber-500/20">
          <div className="flex items-start gap-2">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-amber-500 shrink-0 mt-0.5">
              <path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-cc-fg leading-snug">
                Archiving will <strong>delete the worktree</strong> and any uncommitted changes.
              </p>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={cancelArchive}
                  className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmArchive}
                  className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors cursor-pointer"
                >
                  Archive
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {activeSessions.length === 0 && archivedSessions.length === 0 ? (
          <p className="px-3 py-8 text-xs text-cc-muted text-center leading-relaxed">
            No sessions yet.
          </p>
        ) : (
          <>
            <div className="space-y-0.5">
              {activeProjects.length === 0 ? (
                <p className="px-4 py-8 text-center text-cc-muted text-sm">
                  No active sessions
                </p>
              ) : activeProjects.length === 1 ? (
                /* Single project - render sessions directly without group header */
                activeProjects[0].sessions.map((s) => renderSession(s as typeof allSessionList[number]))
              ) : (
                /* Multiple projects - render with group headers */
                activeProjects.map((project) => {
                  const projectPermCount = project.sessions.reduce(
                    (sum, s) => sum + (pendingPermissions.get(s.id)?.size ?? 0),
                    0,
                  );
                  return (
                    <ProjectGroup
                      key={project.key}
                      project={project}
                      isCollapsed={collapsedProjects.has(project.key)}
                      onToggleCollapse={() => toggleProjectCollapsed(project.key)}
                      onRename={(name) => {
                        setProjectName(project.key, name);
                        api.renameProject(project.key, name).catch(console.error);
                      }}
                      onArchiveAll={async () => {
                        try {
                          const result = await api.archiveAllInProject(project.key);
                          if (result.archived.length > 0) {
                            for (const sid of result.archived) {
                              disconnectSession(sid);
                            }
                            const list = await api.listSessions();
                            useStore.getState().setSdkSessions(list);
                          }
                        } catch (err) {
                          console.error("Failed to archive all:", err);
                        }
                      }}
                      pendingPermissionCount={projectPermCount}
                    >
                      {project.sessions.map((s) => renderSession(s as typeof allSessionList[number]))}
                    </ProjectGroup>
                  );
                })
              )}
            </div>

            {archivedSessions.length > 0 && (
              <div className="mt-2 pt-2 border-t border-cc-border">
                <button
                  onClick={() => setShowArchived(!showArchived)}
                  className="w-full px-3 py-1.5 text-[11px] font-medium text-cc-muted uppercase tracking-wider flex items-center gap-1.5 hover:text-cc-fg transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 transition-transform ${showArchived ? "rotate-90" : ""}`}>
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                  Archived ({archivedSessions.length})
                </button>
                {showArchived && (
                  <div className="space-y-0.5 mt-1">
                    {archivedProjects.length === 0 ? (
                      <p className="px-4 py-4 text-center text-cc-muted text-xs">No archived sessions</p>
                    ) : archivedProjects.length === 1 ? (
                      archivedProjects[0].sessions.map((s) => renderSession(s as typeof allSessionList[number], { isArchived: true }))
                    ) : (
                      archivedProjects.map((project) => (
                        <ProjectGroup
                          key={project.key}
                          project={project}
                          isCollapsed={collapsedProjects.has(`archived:${project.key}`)}
                          onToggleCollapse={() => toggleProjectCollapsed(`archived:${project.key}`)}
                          onRename={(name) => {
                            setProjectName(project.key, name);
                            api.renameProject(project.key, name).catch(console.error);
                          }}
                          pendingPermissionCount={0}
                        >
                          {project.sessions.map((s) => renderSession(s as typeof allSessionList[number], { isArchived: true }))}
                        </ProjectGroup>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-cc-border space-y-0.5">
        <button
          onClick={() => setShowEnvManager(true)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
            <path d="M8 1a2 2 0 012 2v1h2a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h2V3a2 2 0 012-2zm0 1.5a.5.5 0 00-.5.5v1h1V3a.5.5 0 00-.5-.5zM4 5.5a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V6a.5.5 0 00-.5-.5H4z" />
          </svg>
          <span>Environments</span>
        </button>
        <button
          onClick={toggleDarkMode}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          {darkMode ? (
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
            </svg>
          )}
          <span>{darkMode ? "Light mode" : "Dark mode"}</span>
        </button>
      </div>

      {/* Environment manager modal */}
      {showEnvManager && (
        <EnvManager onClose={() => setShowEnvManager(false)} />
      )}
    </aside>
  );
}
