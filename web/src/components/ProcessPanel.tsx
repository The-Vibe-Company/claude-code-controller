import { useState, useCallback, useEffect, useRef } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import type { ProcessItem, SystemProcess } from "../types.js";

const EMPTY_PROCESSES: ProcessItem[] = [];
const SYSTEM_POLL_INTERVAL = 15_000;

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function truncateCommand(cmd: string, max = 60): string {
  const first = cmd.split("\n")[0];
  if (first.length <= max) return first;
  return first.slice(0, max - 3) + "...";
}

// --- Claude Background Task Row ---

function ProcessRow({
  process,
  killing,
  onKill,
}: {
  process: ProcessItem;
  killing: boolean;
  onKill: (() => void) | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Tick every second for running processes to update duration
  useEffect(() => {
    if (process.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [process.status]);

  const statusColor: Record<string, string> = {
    running: "bg-cc-primary",
    completed: "bg-cc-success",
    failed: "bg-cc-error",
    stopped: "bg-cc-muted",
  };

  const duration = process.completedAt
    ? formatDuration(process.completedAt - process.startedAt)
    : formatDuration(now - process.startedAt);

  return (
    <div
      role="listitem"
      className={`px-4 py-2.5 border-b border-cc-border hover:bg-cc-hover/50 transition-colors ${process.status !== "running" ? "opacity-60" : ""}`}
      data-testid="process-row"
    >
      <div className="flex items-start gap-2">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${statusColor[process.status] || "bg-cc-muted"} ${process.status === "running" ? "animate-pulse" : ""}`}
          data-testid="process-status-dot"
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="text-[12px] text-cc-fg font-medium truncate text-left cursor-pointer hover:underline flex-1 min-w-0"
              title={process.description || process.command}
            >
              {process.description || truncateCommand(process.command)}
            </button>
            <span className="text-[10px] text-cc-muted tabular-nums shrink-0">
              {duration}
            </span>
          </div>

          <div className="text-[10px] text-cc-muted mt-0.5">
            ID: {process.taskId || "pending..."}
          </div>

          {expanded && (
            <div className="mt-1.5 space-y-1">
              <pre className="text-[10px] text-cc-muted bg-cc-hover rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all font-mono">
                {process.command}
              </pre>
              {process.summary && (
                <div className="text-[11px] text-cc-muted italic">
                  {process.summary}
                </div>
              )}
            </div>
          )}
        </div>

        {onKill && process.status === "running" && (
          <button
            type="button"
            onClick={onKill}
            disabled={killing}
            className="shrink-0 text-[11px] text-cc-error hover:text-red-500 disabled:opacity-50 transition-colors cursor-pointer px-1.5 py-0.5 rounded hover:bg-cc-hover"
            title="Kill process"
            aria-label={`Kill process ${process.taskId}`}
          >
            {killing ? "..." : "Kill"}
          </button>
        )}
      </div>
    </div>
  );
}

// --- System Dev Process Row ---

function SystemProcessRow({
  proc,
  killing,
  onKill,
}: {
  proc: SystemProcess;
  killing: boolean;
  onKill: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      role="listitem"
      className="px-4 py-2.5 border-b border-cc-border hover:bg-cc-hover/50 transition-colors"
      data-testid="system-process-row"
    >
      <div className="flex items-start gap-2">
        <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 bg-green-500 animate-pulse" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="text-[12px] text-cc-fg font-medium truncate text-left cursor-pointer hover:underline flex-1 min-w-0"
              title={proc.fullCommand}
            >
              {proc.command}
            </button>
            <div className="flex items-center gap-1 shrink-0">
              {proc.ports.map((port) => (
                <span
                  key={port}
                  className="text-[9px] rounded px-1 py-0.5 bg-cc-hover text-cc-muted tabular-nums font-mono"
                >
                  :{port}
                </span>
              ))}
            </div>
          </div>

          <div className="text-[10px] text-cc-muted mt-0.5">
            PID: {proc.pid}
          </div>

          {expanded && (
            <pre className="mt-1.5 text-[10px] text-cc-muted bg-cc-hover rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all font-mono">
              {proc.fullCommand}
            </pre>
          )}
        </div>

        <button
          type="button"
          onClick={onKill}
          disabled={killing}
          className="shrink-0 text-[11px] text-cc-error hover:text-red-500 disabled:opacity-50 transition-colors cursor-pointer px-1.5 py-0.5 rounded hover:bg-cc-hover"
          title="Kill process"
          aria-label={`Kill system process ${proc.pid}`}
        >
          {killing ? "..." : "Kill"}
        </button>
      </div>
    </div>
  );
}

// --- Section Header ---

function SectionHeader({ title, count, action }: { title: string; count?: number; action?: React.ReactNode }) {
  return (
    <div className="shrink-0 px-4 py-2 border-b border-cc-border flex items-center justify-between bg-cc-bg">
      <span className="text-[11px] text-cc-muted uppercase tracking-wider">
        {title}{count !== undefined && count > 0 ? ` (${count})` : ""}
      </span>
      {action}
    </div>
  );
}

// --- Main Panel ---

export function ProcessPanel({ sessionId }: { sessionId: string }) {
  const processes = useStore((s) => s.sessionProcesses.get(sessionId)) || EMPTY_PROCESSES;
  const [killing, setKilling] = useState<Set<string>>(new Set());
  const [systemProcesses, setSystemProcesses] = useState<SystemProcess[]>([]);
  const [killingPids, setKillingPids] = useState<Set<number>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const cancelledRef = useRef(false);

  const runningProcesses = processes.filter((p) => p.status === "running");
  const completedProcesses = processes.filter((p) => p.status !== "running");

  const fetchSystemProcesses = useCallback(async () => {
    try {
      const result = await api.getSystemProcesses(sessionId);
      if (!cancelledRef.current && result.processes) {
        setSystemProcesses(result.processes);
      }
    } catch {
      // Silently handle — endpoint may not be available
    }
  }, [sessionId]);

  // Poll for system dev processes every 15s
  useEffect(() => {
    cancelledRef.current = false;
    fetchSystemProcesses();
    const timer = setInterval(fetchSystemProcesses, SYSTEM_POLL_INTERVAL);
    return () => {
      cancelledRef.current = true;
      clearInterval(timer);
    };
  }, [fetchSystemProcesses]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchSystemProcesses();
    setRefreshing(false);
  }, [fetchSystemProcesses]);

  const handleKill = useCallback(
    async (taskId: string) => {
      setKilling((prev) => new Set([...prev, taskId]));
      try {
        await api.killProcess(sessionId, taskId);
        // Optimistically mark as stopped if no task_notification arrives within 3s
        setTimeout(() => {
          const store = useStore.getState();
          const current = store.sessionProcesses.get(sessionId);
          const proc = current?.find((p) => p.taskId === taskId);
          if (proc && proc.status === "running") {
            store.updateProcess(sessionId, taskId, {
              status: "stopped",
              completedAt: Date.now(),
            });
          }
        }, 3000);
      } catch {
        // Kill request failed — process may already be dead
      } finally {
        setKilling((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }
    },
    [sessionId],
  );

  const handleKillAll = useCallback(async () => {
    const ids = runningProcesses.map((p) => p.taskId).filter(Boolean);
    setKilling(new Set(ids));
    try {
      await api.killAllProcesses(sessionId, ids);
    } catch {
      // silently handle
    } finally {
      setKilling(new Set());
    }
  }, [sessionId, runningProcesses]);

  const handleKillSystemProcess = useCallback(
    async (pid: number) => {
      setKillingPids((prev) => new Set([...prev, pid]));
      try {
        await api.killSystemProcess(sessionId, pid);
        // Remove from local list after a short delay for the kill to take effect
        setTimeout(() => {
          setSystemProcesses((prev) => prev.filter((p) => p.pid !== pid));
        }, 1000);
      } catch {
        // Process may already be dead
      } finally {
        setKillingPids((prev) => {
          const next = new Set(prev);
          next.delete(pid);
          return next;
        });
      }
    },
    [sessionId],
  );

  const hasAnything = processes.length > 0 || systemProcesses.length > 0;

  if (!hasAnything) {
    return (
      <div className="h-full flex flex-col items-center justify-center px-6 text-center bg-cc-bg">
        <div className="w-12 h-12 mb-3 text-cc-muted/40">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M8 9h8m-8 4h6m-2-10h2.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h3 className="text-sm font-medium text-cc-fg mb-1">No background processes</h3>
        <p className="text-xs text-cc-muted max-w-[260px]">
          Background tasks spawned by Claude and dev servers listening on ports will appear here.
        </p>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="mt-3 text-[11px] text-cc-muted hover:text-cc-fg disabled:opacity-50 transition-colors cursor-pointer px-3 py-1 rounded border border-cc-border hover:bg-cc-hover"
          aria-label="Scan for dev servers"
        >
          {refreshing ? "Scanning..." : "Scan for dev servers"}
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-cc-bg">
      <div className="flex-1 overflow-y-auto">
        {/* Claude Background Tasks */}
        {processes.length > 0 && (
          <>
            <SectionHeader
              title="Claude Tasks"
              count={runningProcesses.length}
              action={runningProcesses.length > 1 ? (
                <button
                  type="button"
                  onClick={handleKillAll}
                  className="text-[11px] text-cc-error hover:text-red-500 transition-colors cursor-pointer"
                  aria-label="Kill all running processes"
                >
                  Kill All
                </button>
              ) : undefined}
            />
            <div role="list" aria-label="Background processes">
              {runningProcesses.map((proc) => (
                <ProcessRow
                  key={proc.taskId || proc.toolUseId}
                  process={proc}
                  killing={killing.has(proc.taskId)}
                  onKill={() => handleKill(proc.taskId)}
                />
              ))}

              {completedProcesses.length > 0 && runningProcesses.length > 0 && (
                <div role="presentation" className="px-4 py-1.5 text-[10px] text-cc-muted uppercase tracking-wider border-t border-cc-border">
                  Completed
                </div>
              )}
              {completedProcesses.map((proc) => (
                <ProcessRow
                  key={proc.taskId || proc.toolUseId}
                  process={proc}
                  killing={false}
                  onKill={null}
                />
              ))}
            </div>
          </>
        )}

        {/* System Dev Servers */}
        {systemProcesses.length > 0 && (
          <>
            <SectionHeader
              title="Dev Servers"
              count={systemProcesses.length}
              action={
                <button
                  type="button"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="text-[11px] text-cc-muted hover:text-cc-fg disabled:opacity-50 transition-colors cursor-pointer"
                  aria-label="Refresh system processes"
                >
                  {refreshing ? "..." : "Refresh"}
                </button>
              }
            />
            <div role="list" aria-label="System dev processes">
              {systemProcesses.map((proc) => (
                <SystemProcessRow
                  key={proc.pid}
                  proc={proc}
                  killing={killingPids.has(proc.pid)}
                  onKill={() => handleKillSystemProcess(proc.pid)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
