import { useRef, useEffect } from "react";

interface SessionItemProps {
  session: {
    id: string;
    model?: string;
    cwd?: string;
    gitBranch?: string;
    isWorktree: boolean;
    gitAhead: number;
    gitBehind: number;
    linesAdded: number;
    linesRemoved: number;
    isConnected: boolean;
    status: string | null;
    sdkState?: string | null;
    createdAt?: number;
    archived?: boolean;
    projectKey?: string;
  };
  isActive: boolean;
  sessionName: string | undefined;
  isEditing: boolean;
  editingName: string;
  permCount: number;
  isArchived?: boolean;
  onSelect: () => void;
  onStartRename: (name: string) => void;
  onCancelRename: () => void;
  onConfirmRename: () => void;
  onEditingNameChange: (name: string) => void;
  onArchive: () => void;
  onUnarchive?: () => void;
  onDelete?: () => void;
}

export function SessionItem({
  session: s,
  isActive,
  sessionName,
  isEditing,
  editingName,
  permCount,
  isArchived,
  onSelect,
  onStartRename,
  onCancelRename,
  onConfirmRename,
  onEditingNameChange,
  onArchive,
  onUnarchive,
  onDelete,
}: SessionItemProps) {
  const editInputRef = useRef<HTMLInputElement>(null);

  const shortId = s.id.slice(0, 8);
  const label = sessionName || s.model || shortId;
  const dirName = s.cwd ? s.cwd.split("/").pop() : "";
  const isRunning = s.status === "running";
  const isCompacting = s.status === "compacting";
  const archived = isArchived;

  useEffect(() => {
    if (isEditing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [isEditing]);

  return (
    <div className={`relative group ${archived ? "opacity-60" : ""}`}>
      <button
        onClick={onSelect}
        onDoubleClick={(e) => {
          e.preventDefault();
          onStartRename(label);
        }}
        className={`w-full px-3 py-2.5 ${archived ? "pr-14" : "pr-8"} text-left rounded-[10px] transition-all duration-100 cursor-pointer ${
          isActive
            ? "bg-cc-active"
            : "hover:bg-cc-hover"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="relative flex shrink-0">
            {(isRunning || isCompacting) && !archived ? (
              <svg className="w-2.5 h-2.5 animate-spin text-cc-primary" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <>
                <span
                  className={`w-2 h-2 rounded-full ${
                    archived
                      ? "bg-cc-muted opacity-40"
                      : permCount > 0
                      ? "bg-cc-warning"
                      : s.sdkState === "exited"
                      ? "bg-cc-muted opacity-40"
                      : s.isConnected
                      ? "bg-cc-success opacity-60"
                      : "bg-cc-muted opacity-40"
                  }`}
                />
                {!archived && permCount > 0 && (
                  <span className="absolute inset-0 w-2 h-2 rounded-full bg-cc-warning/40 animate-[pulse-dot_1.5s_ease-in-out_infinite]" />
                )}
              </>
            )}
          </span>
          {isEditing ? (
            <input
              ref={editInputRef}
              value={editingName}
              onChange={(e) => onEditingNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onConfirmRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelRename();
                }
                e.stopPropagation();
              }}
              onBlur={onConfirmRename}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              className="text-[13px] font-medium flex-1 text-cc-fg bg-transparent border border-cc-border rounded-md px-1 py-0 outline-none focus:border-cc-primary/50 min-w-0"
            />
          ) : (
            <span className="text-[13px] font-medium truncate flex-1 text-cc-fg">
              {label}
            </span>
          )}
        </div>
        {(dirName || s.gitBranch) && (
          <div className="flex items-center gap-1.5 mt-0.5 ml-4 text-[11px] text-cc-muted truncate">
            {dirName && <span className="truncate">{dirName}</span>}
            {dirName && s.gitBranch && <span className="text-cc-border">/</span>}
            {s.gitBranch && (
              <span className="flex items-center gap-1 truncate">
                {s.isWorktree ? (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-60">
                    <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v5.256a2.25 2.25 0 101.5 0V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zm7.5-9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V7A2.5 2.5 0 0110 9.5H6a1 1 0 000 2h4a2.5 2.5 0 012.5 2.5v.628a2.25 2.25 0 11-1.5 0V14a1 1 0 00-1-1H6a2.5 2.5 0 01-2.5-2.5V10a2.5 2.5 0 012.5-2.5h4a1 1 0 001-1V5.372a2.25 2.25 0 01-1.5-2.122z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-60">
                    <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                  </svg>
                )}
                <span className="truncate">{s.gitBranch}</span>
                {s.isWorktree && (
                  <span className="text-[9px] bg-cc-primary/10 text-cc-primary px-0.5 rounded">wt</span>
                )}
              </span>
            )}
            {(s.gitAhead > 0 || s.gitBehind > 0) && (
              <span className="flex items-center gap-0.5 text-[10px]">
                {s.gitAhead > 0 && <span className="text-green-500">{s.gitAhead}&#8593;</span>}
                {s.gitBehind > 0 && <span className="text-cc-warning">{s.gitBehind}&#8595;</span>}
              </span>
            )}
            {(s.linesAdded > 0 || s.linesRemoved > 0) && (
              <span className="flex items-center gap-1 shrink-0">
                <span className="text-green-500">+{s.linesAdded}</span>
                <span className="text-red-400">-{s.linesRemoved}</span>
              </span>
            )}
          </div>
        )}
      </button>
      {!archived && permCount > 0 && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-cc-warning text-white text-[10px] font-bold leading-none px-1 group-hover:opacity-0 transition-opacity pointer-events-none">
          {permCount}
        </span>
      )}
      {archived ? (
        <>
          {/* Unarchive button */}
          {onUnarchive && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onUnarchive();
              }}
              className="absolute right-8 top-1/2 -translate-y-1/2 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-cc-border text-cc-muted hover:text-cc-fg transition-all cursor-pointer"
              title="Restore session"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                <path d="M8 10V3M5 5l3-3 3 3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3 13h10" strokeLinecap="round" />
              </svg>
            </button>
          )}
          {/* Delete button */}
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-cc-border text-cc-muted hover:text-red-400 transition-all cursor-pointer"
              title="Delete permanently"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          )}
        </>
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onArchive();
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-cc-border text-cc-muted hover:text-cc-fg transition-all cursor-pointer"
          title="Archive session"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path d="M3 3h10v2H3zM4 5v7a1 1 0 001 1h6a1 1 0 001-1V5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6.5 8h3" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
