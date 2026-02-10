import { useStore } from "../store.js";
import type { TaskItem } from "../types.js";

const EMPTY_TASKS: TaskItem[] = [];

export function TaskPanel({ sessionId }: { sessionId: string }) {
  const tasks = useStore((s) => s.sessionTasks.get(sessionId) || EMPTY_TASKS);
  const session = useStore((s) => s.sessions.get(sessionId));
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);

  if (!taskPanelOpen) return null;

  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const contextPct = session?.context_used_percent ?? 0;

  return (
    <aside className="w-[280px] h-full flex flex-col bg-cc-card border-l border-cc-border">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-cc-border">
        <span className="text-sm font-semibold text-cc-fg tracking-tight">Session</span>
        <button
          onClick={() => setTaskPanelOpen(false)}
          className="flex items-center justify-center w-6 h-6 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* Session stats */}
      {session && (
        <div className="shrink-0 px-4 py-3 border-b border-cc-border space-y-2.5">
          {/* Cost */}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted uppercase tracking-wider">Cost</span>
            <span className="text-[13px] font-medium text-cc-fg tabular-nums">
              ${session.total_cost_usd.toFixed(2)}
            </span>
          </div>

          {/* Context usage */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-cc-muted uppercase tracking-wider">Context</span>
              <span className="text-[11px] text-cc-muted tabular-nums">
                {contextPct > 0 ? `${contextPct}%` : "--"}
              </span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  contextPct > 80
                    ? "bg-cc-error"
                    : contextPct > 50
                    ? "bg-cc-warning"
                    : "bg-cc-primary"
                }`}
                style={{ width: `${Math.min(contextPct, 100)}%` }}
              />
            </div>
          </div>

          {/* Turns */}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted uppercase tracking-wider">Turns</span>
            <span className="text-[13px] font-medium text-cc-fg tabular-nums">
              {session.num_turns}
            </span>
          </div>
        </div>
      )}

      {/* Task section header */}
      <div className="shrink-0 px-4 py-2.5 border-b border-cc-border flex items-center justify-between">
        <span className="text-[12px] font-semibold text-cc-fg">Tasks</span>
        {tasks.length > 0 && (
          <span className="text-[11px] text-cc-muted tabular-nums">
            {completedCount}/{tasks.length}
          </span>
        )}
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {tasks.length === 0 ? (
          <p className="text-xs text-cc-muted text-center py-8">No tasks yet</p>
        ) : (
          <div className="space-y-0.5">
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function TaskRow({ task }: { task: TaskItem }) {
  const isCompleted = task.status === "completed";
  const isInProgress = task.status === "in_progress";

  return (
    <div
      className={`px-2.5 py-2 rounded-lg ${
        isCompleted ? "opacity-50" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        {/* Status icon */}
        <span className="shrink-0 flex items-center justify-center w-4 h-4 mt-px">
          {isInProgress ? (
            <svg className="w-4 h-4 text-cc-primary animate-spin" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
            </svg>
          ) : isCompleted ? (
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-success">
              <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" className="w-4 h-4 text-cc-muted">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
        </span>

        {/* Subject — allow wrapping */}
        <span className={`text-[13px] leading-snug flex-1 ${
          isCompleted ? "text-cc-muted line-through" : "text-cc-fg"
        }`}>
          {task.subject}
        </span>
      </div>

      {/* Active form text (in_progress only) */}
      {isInProgress && task.activeForm && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted italic truncate">
          {task.activeForm}
        </p>
      )}

      {/* Blocked by */}
      {task.blockedBy && task.blockedBy.length > 0 && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted flex items-center gap-1">
          <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 shrink-0">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span>blocked by {task.blockedBy.map((b) => `#${b}`).join(", ")}</span>
        </p>
      )}
    </div>
  );
}
