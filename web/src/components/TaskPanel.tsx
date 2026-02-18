import { useEffect, useState, useCallback } from "react";
import { useStore } from "../store.js";
import { api, type UsageLimits, type GitHubPRInfo } from "../api.js";
import type { TaskItem } from "../types.js";
import { McpSection } from "./McpPanel.js";

const EMPTY_TASKS: TaskItem[] = [];
const POLL_INTERVAL = 60_000;

// Module-level cache — survives session switches so limits don't flash empty
const limitsCache = new Map<string, UsageLimits>();

function formatResetTime(resetsAt: string): string {
  try {
    const diffMs = new Date(resetsAt).getTime() - Date.now();
    if (diffMs <= 0) return "now";
    const days = Math.floor(diffMs / 86_400_000);
    const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h${minutes}m`;
    if (hours > 0) return `${hours}h${minutes}m`;
    return `${minutes}m`;
  } catch {
    return "N/A";
  }
}

function barColor(pct: number): string {
  if (pct > 80) return "bg-cc-error";
  if (pct > 50) return "bg-cc-warning";
  return "bg-cc-primary";
}

function UsageLimitsSection({ sessionId }: { sessionId: string }) {
  const [limits, setLimits] = useState<UsageLimits | null>(
    limitsCache.get(sessionId) ?? null,
  );

  const fetchLimits = useCallback(async () => {
    try {
      const data = await api.getSessionUsageLimits(sessionId);
      limitsCache.set(sessionId, data);
      setLimits(data);
    } catch {
      // silent
    }
  }, [sessionId]);

  // When sessionId changes, show cached value immediately
  useEffect(() => {
    setLimits(limitsCache.get(sessionId) ?? null);
  }, [sessionId]);

  useEffect(() => {
    fetchLimits();
    const id = setInterval(fetchLimits, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchLimits]);

  // Also tick every 30s to refresh the "resets in" countdown
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!limits) return null;

  const has5h = limits.five_hour !== null;
  const has7d = limits.seven_day !== null;
  const hasExtra = !has5h && !has7d && limits.extra_usage?.is_enabled;

  if (!has5h && !has7d && !hasExtra) return null;

  return (
    <div className="shrink-0 px-4 py-3 border-b border-cc-border space-y-2.5">
      {/* 5-hour limit */}
      {limits.five_hour && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted uppercase tracking-wider">
              5h Limit
            </span>
            <span className="text-[11px] text-cc-muted tabular-nums">
              {limits.five_hour.utilization}%
              {limits.five_hour.resets_at && (
                <span className="ml-1 text-cc-muted">
                  ({formatResetTime(limits.five_hour.resets_at)})
                </span>
              )}
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor(limits.five_hour.utilization)}`}
              style={{
                width: `${Math.min(limits.five_hour.utilization, 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* 7-day limit */}
      {limits.seven_day && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted uppercase tracking-wider">
              7d Limit
            </span>
            <span className="text-[11px] text-cc-muted tabular-nums">
              {limits.seven_day.utilization}%
              {limits.seven_day.resets_at && (
                <span className="ml-1 text-cc-muted">
                  ({formatResetTime(limits.seven_day.resets_at)})
                </span>
              )}
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor(limits.seven_day.utilization)}`}
              style={{
                width: `${Math.min(limits.seven_day.utilization, 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Extra usage (only if 5h/7d not available) */}
      {hasExtra && limits.extra_usage && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted uppercase tracking-wider">
              Extra
            </span>
            <span className="text-[11px] text-cc-muted tabular-nums">
              ${limits.extra_usage.used_credits.toFixed(2)} / $
              {limits.extra_usage.monthly_limit}
            </span>
          </div>
          {limits.extra_usage.utilization !== null && (
            <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${barColor(limits.extra_usage.utilization)}`}
                style={{
                  width: `${Math.min(limits.extra_usage.utilization, 100)}%`,
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Codex Rate Limits ───────────────────────────────────────────────────────

function formatCodexResetTime(resetsAtMs: number): string {
  const diffMs = resetsAtMs - Date.now();
  if (diffMs <= 0) return "now";
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function formatWindowDuration(mins: number): string {
  if (mins >= 1440) return `${Math.round(mins / 1440)}d`;
  if (mins >= 60) return `${Math.round(mins / 60)}h`;
  return `${mins}m`;
}

function CodexRateLimitsSection({ sessionId }: { sessionId: string }) {
  const rateLimits = useStore((s) => s.sessions.get(sessionId)?.codex_rate_limits);

  // Tick for countdown refresh
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!rateLimits) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [rateLimits]);

  if (!rateLimits) return null;
  const { primary, secondary } = rateLimits;
  if (!primary && !secondary) return null;

  return (
    <div className="shrink-0 px-4 py-3 border-b border-cc-border space-y-2.5">
      {primary && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted uppercase tracking-wider">
              {formatWindowDuration(primary.windowDurationMins)} Limit
            </span>
            <span className="text-[11px] text-cc-muted tabular-nums">
              {Math.round(primary.usedPercent)}%
              {primary.resetsAt > 0 && (
                <span className="ml-1">
                  ({formatCodexResetTime(primary.resetsAt)})
                </span>
              )}
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor(primary.usedPercent)}`}
              style={{ width: `${Math.min(primary.usedPercent, 100)}%` }}
            />
          </div>
        </div>
      )}
      {secondary && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted uppercase tracking-wider">
              {formatWindowDuration(secondary.windowDurationMins)} Limit
            </span>
            <span className="text-[11px] text-cc-muted tabular-nums">
              {Math.round(secondary.usedPercent)}%
              {secondary.resetsAt > 0 && (
                <span className="ml-1">
                  ({formatCodexResetTime(secondary.resetsAt)})
                </span>
              )}
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor(secondary.usedPercent)}`}
              style={{ width: `${Math.min(secondary.usedPercent, 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Codex Token Details ─────────────────────────────────────────────────────

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function CodexTokenDetailsSection({ sessionId }: { sessionId: string }) {
  const details = useStore((s) => s.sessions.get(sessionId)?.codex_token_details);
  // Use the server-computed context percentage (input+output / contextWindow, capped 0-100)
  const contextPct = useStore((s) => s.sessions.get(sessionId)?.context_used_percent ?? 0);

  if (!details) return null;

  return (
    <div className="shrink-0 px-4 py-3 border-b border-cc-border space-y-2">
      <span className="text-[11px] text-cc-muted uppercase tracking-wider">Tokens</span>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-cc-muted">Input</span>
          <span className="text-[11px] text-cc-fg tabular-nums font-medium">{formatTokenCount(details.inputTokens)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-cc-muted">Output</span>
          <span className="text-[11px] text-cc-fg tabular-nums font-medium">{formatTokenCount(details.outputTokens)}</span>
        </div>
        {details.cachedInputTokens > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted">Cached</span>
            <span className="text-[11px] text-cc-fg tabular-nums font-medium">{formatTokenCount(details.cachedInputTokens)}</span>
          </div>
        )}
        {details.reasoningOutputTokens > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted">Reasoning</span>
            <span className="text-[11px] text-cc-fg tabular-nums font-medium">{formatTokenCount(details.reasoningOutputTokens)}</span>
          </div>
        )}
      </div>
      {details.modelContextWindow > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted">Context</span>
            <span className="text-[11px] text-cc-muted tabular-nums">{contextPct}%</span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor(contextPct)}`}
              style={{ width: `${Math.min(contextPct, 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── GitHub PR Status ────────────────────────────────────────────────────────

function prStatePill(state: GitHubPRInfo["state"], isDraft: boolean) {
  if (isDraft) return { label: "Draft", cls: "text-cc-muted bg-cc-hover" };
  switch (state) {
    case "OPEN": return { label: "Open", cls: "text-cc-success bg-cc-success/10" };
    case "MERGED": return { label: "Merged", cls: "text-purple-400 bg-purple-400/10" };
    case "CLOSED": return { label: "Closed", cls: "text-cc-error bg-cc-error/10" };
  }
}

export function GitHubPRDisplay({ pr }: { pr: GitHubPRInfo }) {
  const pill = prStatePill(pr.state, pr.isDraft);
  const { checksSummary: cs, reviewThreads: rt } = pr;

  return (
    <div className="shrink-0 px-4 py-3 border-b border-cc-border space-y-2">
      {/* Row 1: PR number + state pill */}
      <div className="flex items-center gap-1.5">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[12px] font-semibold text-cc-fg hover:text-cc-primary transition-colors"
        >
          PR #{pr.number}
        </a>
        <span className={`text-[9px] font-medium px-1.5 rounded-full leading-[16px] ${pill.cls}`}>
          {pill.label}
        </span>
      </div>

      {/* Row 2: Title */}
      <p className="text-[11px] text-cc-muted truncate" title={pr.title}>
        {pr.title}
      </p>

      {/* Row 3: CI Checks */}
      {cs.total > 0 && (
        <div className="flex items-center gap-2 text-[11px]">
          {cs.failure > 0 ? (
            <>
              <span className="flex items-center gap-1 text-cc-error">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                </svg>
                {cs.failure} failing
              </span>
              {cs.success > 0 && (
                <span className="flex items-center gap-1 text-cc-success">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" clipRule="evenodd" />
                  </svg>
                  {cs.success} passed
                </span>
              )}
            </>
          ) : cs.pending > 0 ? (
            <span className="flex items-center gap-1 text-cc-warning">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 animate-spin">
                <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8z" opacity=".2" />
                <path d="M8 0a8 8 0 018 8h-2A6 6 0 008 2V0z" />
              </svg>
              {cs.pending} pending
              {cs.success > 0 && (
                <span className="text-cc-success ml-1">{cs.success} passed</span>
              )}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-cc-success">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" clipRule="evenodd" />
              </svg>
              {cs.total}/{cs.total} checks passed
            </span>
          )}
        </div>
      )}

      {/* Row 4: Review + unresolved comments */}
      <div className="flex items-center gap-2 text-[11px]">
        {pr.reviewDecision === "APPROVED" && (
          <span className="flex items-center gap-1 text-cc-success">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
              <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" clipRule="evenodd" />
            </svg>
            Approved
          </span>
        )}
        {pr.reviewDecision === "CHANGES_REQUESTED" && (
          <span className="flex items-center gap-1 text-cc-error">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
              <path fillRule="evenodd" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 11-2 0 1 1 0 012 0zM8 7a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 7z" clipRule="evenodd" />
            </svg>
            Changes requested
          </span>
        )}
        {(pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === null) && pr.state === "OPEN" && (
          <span className="flex items-center gap-1 text-cc-muted">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
              <circle cx="8" cy="8" r="6" />
            </svg>
            Review pending
          </span>
        )}
        {rt.unresolved > 0 && (
          <span className="flex items-center gap-1 text-cc-warning">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
              <path d="M2.5 2A1.5 1.5 0 001 3.5v8A1.5 1.5 0 002.5 13h2v2.5l3.5-2.5h5.5a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0013.5 2h-11z" />
            </svg>
            {rt.unresolved} unresolved
          </span>
        )}
      </div>

      {/* Row 5: Diff stats */}
      <div className="flex items-center gap-1.5 text-[10px] text-cc-muted">
        <span className="text-green-500">+{pr.additions}</span>
        <span className="text-red-400">-{pr.deletions}</span>
        <span>&middot; {pr.changedFiles} files</span>
      </div>
    </div>
  );
}

function GitHubPRSection({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdk = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId));
  const prStatus = useStore((s) => s.prStatus.get(sessionId));

  const cwd = session?.cwd || sdk?.cwd;
  const branch = session?.git_branch || sdk?.gitBranch;

  // One-time REST fallback on mount if no pushed data yet
  useEffect(() => {
    if (prStatus || !cwd || !branch) return;
    api.getPRStatus(cwd, branch).then((data) => {
      useStore.getState().setPRStatus(sessionId, data);
    }).catch(() => {});
  }, [sessionId, cwd, branch, prStatus]);

  if (!prStatus?.available || !prStatus.pr) return null;

  return <GitHubPRDisplay pr={prStatus.pr} />;
}

// ─── Task Panel ──────────────────────────────────────────────────────────────

export { CodexRateLimitsSection, CodexTokenDetailsSection };

export function TaskPanel({ sessionId }: { sessionId: string }) {
  const tasks = useStore((s) => s.sessionTasks.get(sessionId) || EMPTY_TASKS);
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdk = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId));
  const sdkBackendType = sdk?.backendType;
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);
  const isAssistant = useStore((s) => s.assistantSessionId === sessionId);

  if (!taskPanelOpen) return null;

  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const isCodex = (session?.backend_type || sdkBackendType) === "codex";
  const showTasks = !!session && !isCodex;
  const branch = session?.git_branch || sdk?.gitBranch;
  const branchAhead = session?.git_ahead || 0;
  const branchBehind = session?.git_behind || 0;
  const lineAdds = session?.total_lines_added || 0;
  const lineRemoves = session?.total_lines_removed || 0;
  const branchCwd = session?.repo_root || session?.cwd || sdk?.cwd;

  return (
    <aside className="w-[320px] h-full flex flex-col overflow-hidden bg-cc-card border-l border-cc-border">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-cc-border">
        <span className="text-sm font-semibold text-cc-fg tracking-tight">
          Context
        </span>
        <button
          onClick={() => setTaskPanelOpen(false)}
          className="flex items-center justify-center w-6 h-6 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="w-3.5 h-3.5"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      <div data-testid="task-panel-content" className="min-h-0 flex-1 overflow-y-auto">
        {/* Usage limits — Claude Code uses REST-polled limits, Codex uses streamed rate limits */}
        {isCodex ? (
          <>
            <CodexRateLimitsSection sessionId={sessionId} />
            <CodexTokenDetailsSection sessionId={sessionId} />
          </>
        ) : (
          <UsageLimitsSection sessionId={sessionId} />
        )}

        {/* Git branch snapshot — moved from composer for cleaner input surface */}
        {!isAssistant && branch && (
          <div className="shrink-0 px-4 py-3 border-b border-cc-border space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-cc-muted uppercase tracking-wider">
                Branch
              </span>
              {session?.is_containerized && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">container</span>
              )}
            </div>
            <p className="text-xs font-mono-code text-cc-fg truncate" title={branch}>
              {branch}
            </p>
            {(branchAhead > 0 || branchBehind > 0 || lineAdds > 0 || lineRemoves > 0) && (
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[11px]">
                  {branchAhead > 0 && <span className="text-green-500">{branchAhead}&#8593;</span>}
                  {branchBehind > 0 && <span className="text-cc-warning">{branchBehind}&#8595;</span>}
                  {lineAdds > 0 && <span className="text-green-500">+{lineAdds}</span>}
                  {lineRemoves > 0 && <span className="text-red-400">-{lineRemoves}</span>}
                </div>
                {branchBehind > 0 && branchCwd && (
                  <button
                    type="button"
                    className="text-[11px] font-medium text-cc-warning hover:text-amber-400 transition-colors cursor-pointer"
                    onClick={() => {
                      api.gitPull(branchCwd).then((r) => {
                        useStore.getState().updateSession(sessionId, {
                          git_ahead: r.git_ahead,
                          git_behind: r.git_behind,
                        });
                        if (!r.success) console.warn("[git pull]", r.output);
                      }).catch((e) => console.error("[git pull]", e));
                    }}
                    title="Pull latest changes"
                  >
                    Pull
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* GitHub PR status — hidden for assistant (no git context) */}
        {!isAssistant && <GitHubPRSection sessionId={sessionId} />}

        {/* MCP servers */}
        <McpSection sessionId={sessionId} />

        {showTasks && (
          <>
            {/* Task section header */}
            <div className="px-4 py-2.5 border-b border-cc-border flex items-center justify-between">
              <span className="text-[12px] font-semibold text-cc-fg">Tasks</span>
              {tasks.length > 0 && (
                <span className="text-[11px] text-cc-muted tabular-nums">
                  {completedCount}/{tasks.length}
                </span>
              )}
            </div>

            {/* Task list */}
            <div className="px-3 py-2">
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
          </>
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
      className={`px-2.5 py-2 rounded-lg ${isCompleted ? "opacity-50" : ""}`}
    >
      <div className="flex items-start gap-2">
        {/* Status icon */}
        <span className="shrink-0 flex items-center justify-center w-4 h-4 mt-px">
          {isInProgress ? (
            <svg
              className="w-4 h-4 text-cc-primary animate-spin"
              viewBox="0 0 16 16"
              fill="none"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="28"
                strokeDashoffset="8"
                strokeLinecap="round"
              />
            </svg>
          ) : isCompleted ? (
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className="w-4 h-4 text-cc-success"
            >
              <path
                fillRule="evenodd"
                d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              viewBox="0 0 16 16"
              fill="none"
              className="w-4 h-4 text-cc-muted"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          )}
        </span>

        {/* Subject — allow wrapping */}
        <span
          className={`text-[13px] leading-snug flex-1 ${
            isCompleted ? "text-cc-muted line-through" : "text-cc-fg"
          }`}
        >
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
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M5 8h6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span>
            blocked by {task.blockedBy.map((b) => `#${b}`).join(", ")}
          </span>
        </p>
      )}
    </div>
  );
}
