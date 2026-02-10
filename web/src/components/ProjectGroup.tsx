import { useState, useRef, useEffect } from "react";
import type { SidebarProject } from "../types.js";

interface ProjectGroupProps {
  project: SidebarProject;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onRename: (name: string) => void;
  onArchiveAll?: () => void;
  pendingPermissionCount: number;
  children: React.ReactNode;
}

export function ProjectGroup({
  project,
  isCollapsed,
  onToggleCollapse,
  onRename,
  onArchiveAll,
  pendingPermissionCount,
  children,
}: ProjectGroupProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameName, setRenameName] = useState(project.name);
  const [showMenu, setShowMenu] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

  const handleRenameSubmit = () => {
    const trimmed = renameName.trim();
    if (trimmed && trimmed !== project.name) {
      onRename(trimmed);
    }
    setIsRenaming(false);
  };

  const isGitProject = project.key.includes(".git") || project.sessions.some(s => s.gitBranch);

  return (
    <div className="mb-1">
      {/* Project header */}
      <div
        className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-cc-muted hover:text-cc-fg cursor-pointer select-none group"
        onClick={onToggleCollapse}
      >
        {/* Chevron */}
        <svg
          className={`w-3 h-3 shrink-0 transition-transform duration-150 ${isCollapsed ? "-rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>

        {/* Folder/Git icon */}
        {isGitProject ? (
          <svg className="w-3.5 h-3.5 shrink-0 text-cc-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <line x1="12" y1="3" x2="12" y2="9" />
            <line x1="12" y1="15" x2="12" y2="21" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5 shrink-0 text-cc-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        )}

        {/* Name (double-click to rename) */}
        {isRenaming ? (
          <input
            ref={renameInputRef}
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") setIsRenaming(false);
            }}
            className="flex-1 min-w-0 bg-cc-bg border border-cc-border rounded px-1 text-[12px] text-cc-fg outline-none"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="flex-1 min-w-0 truncate font-medium"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenameName(project.name);
              setIsRenaming(true);
            }}
          >
            {project.name}
          </span>
        )}

        {/* Active session count */}
        {project.activeSessions > 0 && (
          <span className="text-[10px] text-cc-muted tabular-nums">
            {project.activeSessions}
          </span>
        )}

        {/* Total cost */}
        {project.totalCost > 0 && (
          <span className="text-[10px] text-cc-muted tabular-nums">
            ${project.totalCost.toFixed(2)}
          </span>
        )}

        {/* Pending permission badge when collapsed */}
        {isCollapsed && pendingPermissionCount > 0 && (
          <span className="w-2 h-2 rounded-full bg-cc-warning animate-pulse" title={`${pendingPermissionCount} pending`} />
        )}

        {/* Menu button */}
        <div className="relative" ref={menuRef}>
          <button
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-cc-bg-hover text-cc-muted"
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu(!showMenu);
            }}
            title="Project options"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </button>

          {showMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-cc-bg border border-cc-border rounded-lg shadow-lg py-1 min-w-[140px]">
              <button
                className="w-full px-3 py-1.5 text-left text-[12px] text-cc-fg hover:bg-cc-bg-hover"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(false);
                  setRenameName(project.name);
                  setIsRenaming(true);
                }}
              >
                Rename
              </button>
              {onArchiveAll && project.activeSessions > 0 && (
                <button
                  className="w-full px-3 py-1.5 text-left text-[12px] text-cc-warning hover:bg-cc-bg-hover"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowMenu(false);
                    onArchiveAll();
                  }}
                >
                  Archive All
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Children (session items) */}
      {!isCollapsed && (
        <div className="ml-2">
          {children}
        </div>
      )}
    </div>
  );
}
