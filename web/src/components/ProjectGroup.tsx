import type { RefObject } from "react";
import type { ProjectGroup as ProjectGroupType } from "../utils/project-grouping.js";
import { SessionItem } from "./SessionItem.js";

interface ProjectGroupProps {
  group: ProjectGroupType;
  isCollapsed: boolean;
  onToggleCollapse: (projectKey: string) => void;
  currentSessionId: string | null;
  sessionNames: Map<string, string>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  recentlyRenamed: Set<string>;
  onSelect: (id: string) => void;
  onStartRename: (id: string, currentName: string) => void;
  onArchive: (e: React.MouseEvent, id: string) => void;
  onUnarchive: (e: React.MouseEvent, id: string) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onClearRecentlyRenamed: (id: string) => void;
  editingSessionId: string | null;
  editingName: string;
  setEditingName: (name: string) => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  editInputRef: RefObject<HTMLInputElement | null>;
  isFirst: boolean;
}

export function ProjectGroup({
  group,
  isCollapsed,
  onToggleCollapse,
  currentSessionId,
  sessionNames,
  pendingPermissions,
  recentlyRenamed,
  onSelect,
  onStartRename,
  onArchive,
  onUnarchive,
  onDelete,
  onClearRecentlyRenamed,
  editingSessionId,
  editingName,
  setEditingName,
  onConfirmRename,
  onCancelRename,
  editInputRef,
  isFirst,
}: ProjectGroupProps) {
  // Build summary badges
  const summaryParts: string[] = [];
  if (group.runningCount > 0) summaryParts.push(`${group.runningCount} running`);
  if (group.permCount > 0) summaryParts.push(`${group.permCount} waiting`);

  return (
    <div className={!isFirst ? "mt-1 pt-1 border-t border-cc-border/50" : ""}>
      {/* Group header */}
      <button
        onClick={() => onToggleCollapse(group.key)}
        className="w-full px-2 py-1.5 flex items-center gap-1.5 hover:bg-cc-hover rounded-md transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted transition-transform ${isCollapsed ? "" : "rotate-90"}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span className="text-[11px] font-semibold text-cc-fg/80 truncate">
          {group.label}
        </span>
        {summaryParts.length > 0 && (
          <span className="text-[10px] text-cc-muted ml-auto shrink-0">
            {summaryParts.map((part, i) => (
              <span key={i}>
                {i > 0 && ", "}
                <span className={part.includes("running") ? "text-cc-success" : "text-cc-warning"}>
                  {part}
                </span>
              </span>
            ))}
          </span>
        )}
        <span className="text-[10px] text-cc-muted/60 shrink-0 ml-1">
          {group.sessions.length}
        </span>
      </button>

      {/* Session list */}
      {!isCollapsed && (
        <div className="space-y-0.5 mt-0.5">
          {group.sessions.map((s) => {
            const permCount = pendingPermissions.get(s.id)?.size ?? 0;
            return (
              <SessionItem
                key={s.id}
                session={s}
                isActive={currentSessionId === s.id}
                sessionName={sessionNames.get(s.id)}
                permCount={permCount}
                isRecentlyRenamed={recentlyRenamed.has(s.id)}
                onSelect={onSelect}
                onStartRename={onStartRename}
                onArchive={onArchive}
                onUnarchive={onUnarchive}
                onDelete={onDelete}
                onClearRecentlyRenamed={onClearRecentlyRenamed}
                editingSessionId={editingSessionId}
                editingName={editingName}
                setEditingName={setEditingName}
                onConfirmRename={onConfirmRename}
                onCancelRename={onCancelRename}
                editInputRef={editInputRef}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
