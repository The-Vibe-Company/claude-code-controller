import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import { useStore } from "../store.js";
import { MessageBubble } from "./MessageBubble.js";
import { getToolIcon, getToolLabel, getPreview, ToolIcon } from "./ToolBlock.js";
import type { ChatMessage, ContentBlock } from "../types.js";

const FEED_PAGE_SIZE = 100;
const savedDistanceFromBottomBySession = new Map<string, number>();

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const EMPTY_MESSAGES: ChatMessage[] = [];

// ─── Message-level grouping ─────────────────────────────────────────────────

interface ToolItem { id: string; name: string; input: Record<string, unknown> }

interface ToolMsgGroup {
  kind: "tool_msg_group";
  toolName: string;
  items: ToolItem[];
  firstId: string;
}

interface SubagentGroup {
  kind: "subagent";
  taskToolUseId: string;
  description: string;
  agentType: string;
  children: FeedEntry[];
}

type FeedEntry =
  | { kind: "message"; msg: ChatMessage }
  | ToolMsgGroup
  | SubagentGroup;

/**
 * Get the dominant tool name if this message is "tool-only"
 * (assistant message whose contentBlocks are ALL tool_use of the same name).
 * Returns null if it has text/thinking or mixed tool types.
 */
function getToolOnlyName(msg: ChatMessage): string | null {
  if (msg.role !== "assistant") return null;
  const blocks = msg.contentBlocks;
  if (!blocks || blocks.length === 0) return null;

  let toolName: string | null = null;
  for (const b of blocks) {
    if (b.type === "text" && b.text.trim()) return null;
    if (b.type === "thinking") return null;
    if (b.type === "tool_use") {
      if (toolName === null) toolName = b.name;
      else if (toolName !== b.name) return null;
    }
  }
  return toolName;
}

function extractToolItems(msg: ChatMessage): ToolItem[] {
  const blocks = msg.contentBlocks || [];
  return blocks
    .filter((b): b is ContentBlock & { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
}

/** Get Task tool_use IDs from a feed entry */
function getTaskIdsFromEntry(entry: FeedEntry): string[] {
  if (entry.kind === "message") {
    const blocks = entry.msg.contentBlocks || [];
    return blocks
      .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
      .filter(b => b.name === "Task")
      .map(b => b.id);
  }
  if (entry.kind === "tool_msg_group" && entry.toolName === "Task") {
    return entry.items.map(item => item.id);
  }
  return [];
}

/** Group consecutive same-tool messages */
function groupToolMessages(messages: ChatMessage[]): FeedEntry[] {
  const entries: FeedEntry[] = [];

  for (const msg of messages) {
    const toolName = getToolOnlyName(msg);

    if (toolName) {
      const last = entries[entries.length - 1];
      if (last?.kind === "tool_msg_group" && last.toolName === toolName) {
        last.items.push(...extractToolItems(msg));
        continue;
      }
      entries.push({
        kind: "tool_msg_group",
        toolName,
        items: extractToolItems(msg),
        firstId: msg.id,
      });
    } else {
      entries.push({ kind: "message", msg });
    }
  }

  return entries;
}

/** Build feed entries with subagent nesting */
function buildEntries(
  messages: ChatMessage[],
  taskInfo: Map<string, { description: string; agentType: string }>,
  childrenByParent: Map<string, ChatMessage[]>,
): FeedEntry[] {
  const grouped = groupToolMessages(messages);

  const result: FeedEntry[] = [];
  for (const entry of grouped) {
    result.push(entry);

    // After each entry containing Task tool_use(s), insert subagent groups
    const taskIds = getTaskIdsFromEntry(entry);
    for (const taskId of taskIds) {
      const children = childrenByParent.get(taskId);
      if (children && children.length > 0) {
        const info = taskInfo.get(taskId) || { description: "Subagent", agentType: "" };
        const childEntries = buildEntries(children, taskInfo, childrenByParent);
        result.push({
          kind: "subagent",
          taskToolUseId: taskId,
          description: info.description,
          agentType: info.agentType,
          children: childEntries,
        });
      }
    }
  }

  return result;
}

function groupMessages(messages: ChatMessage[]): FeedEntry[] {
  // Phase 1: Find all Task tool_use IDs across all messages
  const taskInfo = new Map<string, { description: string; agentType: string }>();
  for (const msg of messages) {
    if (!msg.contentBlocks) continue;
    for (const b of msg.contentBlocks) {
      if (b.type === "tool_use" && b.name === "Task") {
        const { input, id } = b;
        taskInfo.set(id, {
          description: String(input?.description || "Subagent"),
          agentType: String(input?.subagent_type || ""),
        });
      }
    }
  }

  // If no Task tool_uses found, skip the overhead
  if (taskInfo.size === 0) {
    return groupToolMessages(messages);
  }

  // Phase 2: Partition into top-level and child messages
  const childrenByParent = new Map<string, ChatMessage[]>();
  const topLevel: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.parentToolUseId && taskInfo.has(msg.parentToolUseId)) {
      let arr = childrenByParent.get(msg.parentToolUseId);
      if (!arr) { arr = []; childrenByParent.set(msg.parentToolUseId, arr); }
      arr.push(msg);
    } else {
      topLevel.push(msg);
    }
  }

  // Phase 3: Build grouped entries with subagent nesting
  return buildEntries(topLevel, taskInfo, childrenByParent);
}

// ─── Components ──────────────────────────────────────────────────────────────

function ToolMessageGroup({ group }: { group: ToolMsgGroup }) {
  const [open, setOpen] = useState(false);
  const iconType = getToolIcon(group.toolName);
  const label = getToolLabel(group.toolName);
  const count = group.items.length;

  // Single item — don't group, render inline
  if (count === 1) {
    const item = group.items[0];
    return (
      <div className="animate-[fadeSlideIn_0.2s_ease-out]">
        <div className="flex items-start gap-3">
          <AssistantAvatar />
          <div className="flex-1 min-w-0">
            <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
              <button
                onClick={() => setOpen(!open)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}>
                  <path d="M6 4l4 4-4 4" />
                </svg>
                <ToolIcon type={iconType} />
                <span className="text-xs font-medium text-cc-fg">{label}</span>
                <span className="text-xs text-cc-muted truncate flex-1 font-mono-code">
                  {getPreview(item.name, item.input)}
                </span>
              </button>
              {open && (
                <div className="px-3 pb-3 pt-0 border-t border-cc-border mt-0">
                  <pre className="mt-2 text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
                    {JSON.stringify(item.input, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Multi-item group
  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="flex items-start gap-3">
        <AssistantAvatar />
        <div className="flex-1 min-w-0">
          <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
            <button
              onClick={() => setOpen(!open)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}>
                <path d="M6 4l4 4-4 4" />
              </svg>
              <ToolIcon type={iconType} />
              <span className="text-xs font-medium text-cc-fg">{label}</span>
              <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums font-medium">
                {count}
              </span>
            </button>

            {open && (
              <div className="border-t border-cc-border px-3 py-1.5">
                {group.items.map((item, i) => {
                  const preview = getPreview(item.name, item.input);
                  return (
                    <div key={item.id || i} className="flex items-center gap-2 py-1 text-xs text-cc-muted font-mono-code truncate">
                      <span className="w-1 h-1 rounded-full bg-cc-muted/40 shrink-0" />
                      <span className="truncate">{preview || JSON.stringify(item.input).slice(0, 80)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FeedEntries({ entries }: { entries: FeedEntry[] }) {
  return (
    <>
      {entries.map((entry, i) => {
        if (entry.kind === "tool_msg_group") {
          return <ToolMessageGroup key={entry.firstId || i} group={entry} />;
        }
        if (entry.kind === "subagent") {
          return <SubagentContainer key={entry.taskToolUseId} group={entry} />;
        }
        return <MessageBubble key={entry.msg.id} message={entry.msg} />;
      })}
    </>
  );
}

function SubagentContainer({ group }: { group: SubagentGroup }) {
  const [open, setOpen] = useState(false);
  const label = group.description || "Subagent";
  const agentType = group.agentType;
  const childCount = group.children.length;

  // Get the last visible entry for a compact preview
  const lastEntry = group.children[group.children.length - 1];
  const lastPreview = useMemo(() => {
    if (!lastEntry) return "";
    if (lastEntry.kind === "tool_msg_group") {
      const item = lastEntry.items[lastEntry.items.length - 1];
      return `${getToolLabel(lastEntry.toolName)}${lastEntry.items.length > 1 ? ` ×${lastEntry.items.length}` : ""}`;
    }
    if (lastEntry.kind === "message" && lastEntry.msg.role === "assistant") {
      const text = lastEntry.msg.content?.trim();
      if (text) return text.length > 60 ? text.slice(0, 60) + "..." : text;
      const toolBlock = lastEntry.msg.contentBlocks?.find(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use"
      );
      if (toolBlock) return getToolLabel(toolBlock.name);
    }
    return "";
  }, [lastEntry]);

  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="ml-9 border-l-2 border-cc-primary/20 pl-4">
        <button
          onClick={() => setOpen(!open)}
          className="w-full flex items-center gap-2 py-1.5 text-left cursor-pointer mb-1"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}>
            <path d="M6 4l4 4-4 4" />
          </svg>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 text-cc-primary shrink-0">
            <circle cx="8" cy="8" r="5" />
            <path d="M8 5v3l2 1" strokeLinecap="round" />
          </svg>
          <span className="text-xs font-medium text-cc-fg truncate">{label}</span>
          {agentType && (
            <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 shrink-0">
              {agentType}
            </span>
          )}
          {!open && lastPreview && (
            <span className="text-[11px] text-cc-muted truncate ml-1 font-mono-code">
              {lastPreview}
            </span>
          )}
          <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums shrink-0 ml-auto">
            {childCount}
          </span>
        </button>

        {open && (
          <div className="space-y-3 pb-2">
            <FeedEntries entries={group.children} />
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantAvatar() {
  return (
    <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-primary">
        <circle cx="8" cy="8" r="3" />
      </svg>
    </div>
  );
}

// ─── Main Feed ───────────────────────────────────────────────────────────────

export function MessageFeed({ sessionId }: { sessionId: string }) {
  const messages = useStore((s) => s.messages.get(sessionId) ?? EMPTY_MESSAGES);
  const streamingText = useStore((s) => s.streaming.get(sessionId));
  const streamingStartedAt = useStore((s) => s.streamingStartedAt.get(sessionId));
  const streamingOutputTokens = useStore((s) => s.streamingOutputTokens.get(sessionId));
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const toolProgress = useStore((s) => s.toolProgress.get(sessionId));
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const [elapsed, setElapsed] = useState(0);
  const [visibleCount, setVisibleCount] = useState(FEED_PAGE_SIZE);
  const chatTabReentryTick = useStore((s) => s.chatTabReentryTickBySession.get(sessionId) ?? 0);

  const grouped = useMemo(() => groupMessages(messages), [messages]);

  // Reset visible count when switching sessions
  useEffect(() => {
    setVisibleCount(FEED_PAGE_SIZE);
  }, [sessionId]);

  const totalEntries = grouped.length;
  const hasMore = totalEntries > visibleCount;
  const visibleEntries = hasMore ? grouped.slice(totalEntries - visibleCount) : grouped;
  const hiddenCount = totalEntries - visibleEntries.length;

  const handleLoadMore = useCallback(() => {
    const el = containerRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    setVisibleCount((c) => c + FEED_PAGE_SIZE);
    // Preserve scroll position after DOM updates
    requestAnimationFrame(() => {
      if (el) {
        const newHeight = el.scrollHeight;
        el.scrollTop += newHeight - prevHeight;
      }
    });
  }, []);

  // Tick elapsed time every second while generating
  useEffect(() => {
    if (!streamingStartedAt && sessionStatus !== "running") {
      setElapsed(0);
      return;
    }
    const start = streamingStartedAt || Date.now();
    setElapsed(Date.now() - start);
    const interval = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(interval);
  }, [streamingStartedAt, sessionStatus]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    isNearBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    const distanceFromBottom = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
    savedDistanceFromBottomBySession.set(sessionId, distanceFromBottom);
  }

  const scrollToBottomInstant = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const previousBehavior = el.style.scrollBehavior;
    el.style.scrollBehavior = "auto";
    el.scrollTop = el.scrollHeight;
    el.style.scrollBehavior = previousBehavior;
  }, []);

  const restoreSavedScrollPosition = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const previousBehavior = el.style.scrollBehavior;
    el.style.scrollBehavior = "auto";
    const savedDistance = savedDistanceFromBottomBySession.get(sessionId);
    if (typeof savedDistance === "number") {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - savedDistance);
    } else {
      el.scrollTop = el.scrollHeight;
    }
    el.style.scrollBehavior = previousBehavior;
  }, [sessionId]);

  // On mount / session switch, restore previous reading position (or default to bottom).
  useEffect(() => {
    requestAnimationFrame(() => restoreSavedScrollPosition());
  }, [sessionId, restoreSavedScrollPosition]);

  // Persist the current scroll position for this session on unmount.
  useEffect(() => {
    return () => {
      const el = containerRef.current;
      if (!el) return;
      const distanceFromBottom = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
      savedDistanceFromBottomBySession.set(sessionId, distanceFromBottom);
    };
  }, [sessionId]);

  // Only force bottom on explicit workspace tab switch back to chat.
  useEffect(() => {
    if (!chatTabReentryTick) return;
    requestAnimationFrame(() => scrollToBottomInstant());
  }, [chatTabReentryTick, scrollToBottomInstant]);

  useEffect(() => {
    if (isNearBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, streamingText]);

  if (messages.length === 0 && !streamingText) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 select-none px-6">
        <div className="w-14 h-14 rounded-2xl bg-cc-card border border-cc-border flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 text-cc-muted">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-sm text-cc-fg font-medium mb-1">Start a conversation</p>
          <p className="text-xs text-cc-muted leading-relaxed">
            Send a message to begin working with The Companion.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 relative overflow-hidden">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-3 sm:px-4 py-4 sm:py-6"
      >
        <div className="max-w-3xl mx-auto space-y-3 sm:space-y-5">
          {hasMore && (
            <div className="flex justify-center pb-2">
              <button
                onClick={handleLoadMore}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-cc-muted hover:text-cc-fg bg-cc-card border border-cc-border rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
                </svg>
                Load {Math.min(FEED_PAGE_SIZE, hiddenCount)} more ({hiddenCount} hidden)
              </button>
            </div>
          )}
          <FeedEntries entries={visibleEntries} />

          {/* Tool progress indicator */}
          {toolProgress && toolProgress.size > 0 && !streamingText && (
            <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-cc-primary animate-pulse" />
              {Array.from(toolProgress.values()).map((p, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span className="text-cc-muted/40">·</span>}
                  <span>{getToolLabel(p.toolName)}</span>
                  <span className="text-cc-muted/60">{p.elapsedSeconds}s</span>
                </span>
              ))}
            </div>
          )}

          {/* Streaming indicator */}
          {streamingText && (
            <div className="animate-[fadeSlideIn_0.2s_ease-out]">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-cc-primary">
                    <path d="M8 1v14M1 8h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <pre className="font-serif-assistant text-[15px] text-cc-fg whitespace-pre-wrap break-words leading-relaxed">
                    {streamingText}
                    <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                  </pre>
                </div>
              </div>
            </div>
          )}

          {/* Generation stats bar */}
          {sessionStatus === "running" && elapsed > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-cc-primary animate-pulse" />
              <span>Generating...</span>
              <span className="text-cc-muted/60">(</span>
              <span>{formatElapsed(elapsed)}</span>
              {(streamingOutputTokens ?? 0) > 0 && (
                <>
                  <span className="text-cc-muted/40">·</span>
                  <span>↓ {formatTokens(streamingOutputTokens!)}</span>
                </>
              )}
              <span className="text-cc-muted/60">)</span>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
