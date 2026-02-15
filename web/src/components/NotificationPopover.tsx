import { useEffect, useRef, useMemo } from "react";
import { useStore } from "../store.js";
import type { PluginInsight } from "../types.js";

const EMPTY_INSIGHTS: PluginInsight[] = [];

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function timeGroup(ts: number): "just-now" | "recent" | "earlier" {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just-now";
  if (diff < 3_600_000) return "recent";
  return "earlier";
}

const GROUP_LABELS: Record<string, string> = {
  "just-now": "Just now",
  "recent": "Recent",
  "earlier": "Earlier",
};

function insightLevelColor(level: PluginInsight["level"]): string {
  switch (level) {
    case "success": return "text-cc-success";
    case "error": return "text-cc-error";
    case "warning": return "text-cc-warning";
    default: return "text-cc-primary";
  }
}

function LevelDot({ level }: { level: PluginInsight["level"] }) {
  const color = level === "success" ? "bg-cc-success"
    : level === "error" ? "bg-cc-error"
    : level === "warning" ? "bg-cc-warning"
    : "bg-cc-primary";
  return <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

function LevelIcon({ level }: { level: PluginInsight["level"] }) {
  const cls = `w-3.5 h-3.5 shrink-0 ${insightLevelColor(level)}`;
  switch (level) {
    case "success":
      return (
        <svg viewBox="0 0 16 16" fill="currentColor" className={cls}>
          <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" clipRule="evenodd" />
        </svg>
      );
    case "error":
      return (
        <svg viewBox="0 0 16 16" fill="currentColor" className={cls}>
          <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
        </svg>
      );
    case "warning":
      return (
        <svg viewBox="0 0 16 16" fill="currentColor" className={cls}>
          <path fillRule="evenodd" d="M8.893 1.5c-.183-.31-.52-.5-.887-.5s-.703.19-.886.5L.138 13a1.02 1.02 0 00.886 1.5h13.953c.367 0 .704-.19.886-.5s.184-.61 0-.92L8.893 1.5zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 16 16" fill="currentColor" className={cls}>
          <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm.75-10.25a.75.75 0 00-1.5 0v1a.75.75 0 001.5 0v-1zM8 7a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 7z" clipRule="evenodd" />
        </svg>
      );
  }
}

function InsightRow({ insight, pluginName }: { insight: PluginInsight; pluginName?: string }) {
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 hover:bg-cc-hover/50 rounded-lg transition-colors">
      <div className="mt-0.5">
        <LevelIcon level={insight.level} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-cc-fg truncate">{insight.title}</span>
          <span className="text-[10px] text-cc-muted shrink-0">{relativeTime(insight.timestamp)}</span>
        </div>
        <p className="text-[11px] text-cc-muted mt-0.5 line-clamp-2">{insight.message}</p>
        {pluginName && (
          <span className="inline-block mt-1 text-[9px] font-medium text-cc-muted bg-cc-hover rounded-full px-1.5 leading-[14px]">
            {pluginName}
          </span>
        )}
      </div>
    </div>
  );
}

export function NotificationPopover() {
  const ref = useRef<HTMLDivElement>(null);
  const open = useStore((s) => s.notificationPopoverOpen);
  const setOpen = useStore((s) => s.setNotificationPopoverOpen);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const insights = useStore((s) => {
    if (!currentSessionId) return EMPTY_INSIGHTS;
    return s.pluginInsights.get(currentSessionId) || EMPTY_INSIGHTS;
  });
  const plugins = useStore((s) => s.plugins);
  const clearPluginInsights = useStore((s) => s.clearPluginInsights);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);

  const pluginNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of plugins) map.set(p.id, p.name);
    return map;
  }, [plugins]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    // Delay to avoid the opening click triggering immediate close
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [open, setOpen]);

  // Mark insights as read when opened
  useEffect(() => {
    if (open && currentSessionId) {
      useStore.getState().markInsightsRead(currentSessionId);
    }
  }, [open, currentSessionId]);

  if (!open) return null;

  // Group insights by time (most recent first)
  const sorted = [...insights].reverse();
  const groups: { key: string; label: string; items: PluginInsight[] }[] = [];
  const groupOrder = ["just-now", "recent", "earlier"] as const;
  const grouped = new Map<string, PluginInsight[]>();
  for (const insight of sorted) {
    const g = timeGroup(insight.timestamp);
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g)!.push(insight);
  }
  for (const key of groupOrder) {
    const items = grouped.get(key);
    if (items?.length) {
      groups.push({ key, label: GROUP_LABELS[key], items });
    }
  }

  const hasMultiplePlugins = new Set(insights.map((i) => i.plugin_id)).size > 1;

  return (
    <div
      ref={ref}
      className="absolute top-full right-0 mt-2 w-[360px] max-h-[480px] flex flex-col bg-cc-card border border-cc-border rounded-xl shadow-xl overflow-hidden z-50"
      style={{ animation: "fadeSlideIn 0.15s ease-out" }}
    >
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-cc-border">
        <span className="text-[13px] font-semibold text-cc-fg">Notifications</span>
        <div className="flex items-center gap-2">
          {insights.length > 0 && (
            <button
              onClick={() => {
                if (currentSessionId) clearPluginInsights(currentSessionId);
              }}
              className="text-[11px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <svg viewBox="0 0 48 48" fill="none" className="w-12 h-12 text-cc-muted opacity-30 mb-3">
              <path d="M24 4C14.06 4 6 12.06 6 22v8l-2 4h40l-2-4v-8C42 12.06 33.94 4 24 4z" stroke="currentColor" strokeWidth="2" fill="none" />
              <path d="M18 38a6 6 0 0012 0" stroke="currentColor" strokeWidth="2" fill="none" />
            </svg>
            <p className="text-[13px] text-cc-muted">No notifications yet</p>
            <p className="text-[11px] text-cc-muted mt-1">Plugin insights will appear here</p>
          </div>
        ) : (
          <div className="py-1">
            {groups.map((group) => (
              <div key={group.key}>
                <div className="px-4 pt-3 pb-1">
                  <span className="text-[10px] font-semibold text-cc-muted uppercase tracking-wider">{group.label}</span>
                </div>
                {group.items.map((insight) => (
                  <InsightRow
                    key={insight.id}
                    insight={insight}
                    pluginName={hasMultiplePlugins ? pluginNameById.get(insight.plugin_id) : undefined}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      {sorted.length > 0 && (
        <div className="shrink-0 flex items-center justify-center px-4 py-2.5 border-t border-cc-border">
          <button
            onClick={() => {
              setOpen(false);
              setTaskPanelOpen(true);
            }}
            className="text-[11px] text-cc-primary hover:text-cc-primary-hover font-medium transition-colors cursor-pointer"
          >
            View all in panel
          </button>
        </div>
      )}
    </div>
  );
}
