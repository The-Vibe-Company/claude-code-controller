import { useStore } from "./store.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, ContentBlock, ChatMessage, TaskItem, SdkSessionInfo } from "./types.js";
import { generateUniqueSessionName } from "./utils/names.js";
import { playNotificationSound } from "./utils/notification-sound.js";

const sockets = new Map<string, WebSocket>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const taskCounters = new Map<string, number>();
/** Track processed tool_use IDs to prevent duplicate task creation */
const processedToolUseIds = new Map<string, Set<string>>();

function getProcessedSet(sessionId: string): Set<string> {
  let set = processedToolUseIds.get(sessionId);
  if (!set) {
    set = new Set();
    processedToolUseIds.set(sessionId, set);
  }
  return set;
}

function extractTasksFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();
  const processed = getProcessedSet(sessionId);

  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const { name, input, id: toolUseId } = block;

    // Deduplicate by tool_use_id
    if (toolUseId) {
      if (processed.has(toolUseId)) continue;
      processed.add(toolUseId);
    }

    // TodoWrite: full replacement — { todos: [{ content, status, activeForm }] }
    if (name === "TodoWrite") {
      const todos = input.todos as { content?: string; status?: string; activeForm?: string }[] | undefined;
      if (Array.isArray(todos)) {
        const tasks: TaskItem[] = todos.map((t, i) => ({
          id: String(i + 1),
          subject: t.content || "Task",
          description: "",
          activeForm: t.activeForm,
          status: (t.status as TaskItem["status"]) || "pending",
        }));
        store.setTasks(sessionId, tasks);
        taskCounters.set(sessionId, tasks.length);
      }
      continue;
    }

    // TaskCreate: incremental add — { subject, description, activeForm }
    if (name === "TaskCreate") {
      const count = (taskCounters.get(sessionId) || 0) + 1;
      taskCounters.set(sessionId, count);
      const task = {
        id: String(count),
        subject: (input.subject as string) || "Task",
        description: (input.description as string) || "",
        activeForm: input.activeForm as string | undefined,
        status: "pending" as const,
      };
      store.addTask(sessionId, task);
      continue;
    }

    // TaskUpdate: incremental update — { taskId, status, owner, activeForm, addBlockedBy }
    if (name === "TaskUpdate") {
      const taskId = input.taskId as string;
      if (taskId) {
        const updates: Partial<TaskItem> = {};
        if (input.status) updates.status = input.status as TaskItem["status"];
        if (input.owner) updates.owner = input.owner as string;
        if (input.activeForm !== undefined) updates.activeForm = input.activeForm as string;
        if (input.addBlockedBy) updates.blockedBy = input.addBlockedBy as string[];
        store.updateTask(sessionId, taskId, updates);
      }
    }
  }
}

function extractChangedFilesFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const { name, input } = block;
    if ((name === "Edit" || name === "Write") && typeof input.file_path === "string") {
      store.addChangedFile(sessionId, input.file_path);
    }
  }
}

let idCounter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++idCounter}`;
}

function getWsUrl(sessionId: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/browser/${sessionId}`;
}

function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "thinking") return b.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function handleMessage(sessionId: string, event: MessageEvent) {
  const store = useStore.getState();
  let data: BrowserIncomingMessage;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }

  switch (data.type) {
    case "session_init": {
      store.addSession(data.session);
      store.setCliConnected(sessionId, true);
      store.setSessionStatus(sessionId, "idle");
      if (!store.sessionNames.has(sessionId)) {
        const existingNames = new Set(store.sessionNames.values());
        const name = generateUniqueSessionName(existingNames);
        store.setSessionName(sessionId, name);
      }
      break;
    }

    case "session_update": {
      store.updateSession(sessionId, data.session);
      break;
    }

    case "assistant": {
      const msg = data.message;
      const textContent = extractTextFromBlocks(msg.content);
      const chatMsg: ChatMessage = {
        id: msg.id,
        role: "assistant",
        content: textContent,
        contentBlocks: msg.content,
        timestamp: data.timestamp || Date.now(),
        parentToolUseId: data.parent_tool_use_id,
        model: msg.model,
        stopReason: msg.stop_reason,
      };
      store.appendMessage(sessionId, chatMsg);
      store.setStreaming(sessionId, null);
      store.setSessionStatus(sessionId, "running");

      // Start timer if not already started (for non-streaming tool calls)
      if (!store.streamingStartedAt.has(sessionId)) {
        store.setStreamingStats(sessionId, { startedAt: Date.now() });
      }

      // Extract tasks and changed files from tool_use content blocks
      if (msg.content?.length) {
        extractTasksFromBlocks(sessionId, msg.content);
        extractChangedFilesFromBlocks(sessionId, msg.content);
      }

      break;
    }

    case "stream_event": {
      const evt = data.event as Record<string, unknown>;
      if (evt && typeof evt === "object") {
        // message_start → mark generation start time
        if (evt.type === "message_start") {
          if (!store.streamingStartedAt.has(sessionId)) {
            store.setStreamingStats(sessionId, { startedAt: Date.now(), outputTokens: 0 });
          }
        }

        // content_block_delta → accumulate streaming text
        if (evt.type === "content_block_delta") {
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            const current = store.streaming.get(sessionId) || "";
            store.setStreaming(sessionId, current + delta.text);
          }
        }

        // message_delta → extract output token count
        if (evt.type === "message_delta") {
          const usage = (evt as { usage?: { output_tokens?: number } }).usage;
          if (usage?.output_tokens) {
            store.setStreamingStats(sessionId, { outputTokens: usage.output_tokens });
          }
        }
      }
      break;
    }

    case "result": {
      const r = data.data;
      const sessionUpdates: Partial<{ total_cost_usd: number; num_turns: number; context_used_percent: number; total_lines_added: number; total_lines_removed: number }> = {
        total_cost_usd: r.total_cost_usd,
        num_turns: r.num_turns,
      };
      // Forward lines changed if present
      if (typeof r.total_lines_added === "number") {
        sessionUpdates.total_lines_added = r.total_lines_added;
      }
      if (typeof r.total_lines_removed === "number") {
        sessionUpdates.total_lines_removed = r.total_lines_removed;
      }
      // Compute context % from modelUsage if available
      if (r.modelUsage) {
        for (const usage of Object.values(r.modelUsage)) {
          if (usage.contextWindow > 0) {
            const pct = Math.round(
              ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100
            );
            sessionUpdates.context_used_percent = Math.max(0, Math.min(pct, 100));
          }
        }
      }
      store.updateSession(sessionId, sessionUpdates);
      store.setStreaming(sessionId, null);
      store.setStreamingStats(sessionId, null);
      store.setSessionStatus(sessionId, "idle");
      // Play notification sound if enabled and tab is not focused
      if (!document.hasFocus() && store.notificationSound) {
        playNotificationSound();
      }
      if (r.is_error && r.errors?.length) {
        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: `Error: ${r.errors.join(", ")}`,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "permission_request": {
      store.addPermission(sessionId, data.request);
      // Also extract tasks and changed files from permission requests
      const req = data.request;
      if (req.tool_name && req.input) {
        const permBlocks = [{
          type: "tool_use" as const,
          id: req.tool_use_id,
          name: req.tool_name,
          input: req.input,
        }];
        extractTasksFromBlocks(sessionId, permBlocks);
        extractChangedFilesFromBlocks(sessionId, permBlocks);
      }
      break;
    }

    case "permission_cancelled": {
      store.removePermission(sessionId, data.request_id);
      break;
    }

    case "tool_progress": {
      // Could be used for progress indicators; ignored for now
      break;
    }

    case "tool_use_summary": {
      // Optional: add as system message
      break;
    }

    case "status_change": {
      if (data.status === "compacting") {
        store.setSessionStatus(sessionId, "compacting");
      } else {
        store.setSessionStatus(sessionId, data.status);
      }
      break;
    }

    case "auth_status": {
      if (data.error) {
        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: `Auth error: ${data.error}`,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "error": {
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: data.message,
        timestamp: Date.now(),
      });
      break;
    }

    case "cli_disconnected": {
      store.setCliConnected(sessionId, false);
      store.setSessionStatus(sessionId, null);
      break;
    }

    case "cli_connected": {
      store.setCliConnected(sessionId, true);
      break;
    }

    case "session_name_update": {
      // Only apply auto-name if user hasn't manually renamed (still has random Adj+Noun name)
      const currentName = store.sessionNames.get(sessionId);
      const isRandomName = currentName && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(currentName);
      if (!currentName || isRandomName) {
        store.setSessionName(sessionId, data.name);
        store.markRecentlyRenamed(sessionId);
      }
      break;
    }

    case "message_history": {
      const chatMessages: ChatMessage[] = [];
      for (let i = 0; i < data.messages.length; i++) {
        const histMsg = data.messages[i];
        if (histMsg.type === "user_message") {
          chatMessages.push({
            id: histMsg.id || nextId(),
            role: "user",
            content: histMsg.content,
            timestamp: histMsg.timestamp,
          });
        } else if (histMsg.type === "assistant") {
          const msg = histMsg.message;
          const textContent = extractTextFromBlocks(msg.content);
          chatMessages.push({
            id: msg.id,
            role: "assistant",
            content: textContent,
            contentBlocks: msg.content,
            timestamp: histMsg.timestamp || Date.now(),
            parentToolUseId: histMsg.parent_tool_use_id,
            model: msg.model,
            stopReason: msg.stop_reason,
          });
          // Also extract tasks and changed files from history
          if (msg.content?.length) {
            extractTasksFromBlocks(sessionId, msg.content);
            extractChangedFilesFromBlocks(sessionId, msg.content);
          }
        } else if (histMsg.type === "result") {
          const r = histMsg.data;
          if (r.is_error && r.errors?.length) {
            chatMessages.push({
              id: `hist-error-${i}`,
              role: "system",
              content: `Error: ${r.errors.join(", ")}`,
              timestamp: Date.now(),
            });
          }
        }
      }
      if (chatMessages.length > 0) {
        const existing = store.messages.get(sessionId) || [];
        if (existing.length === 0) {
          // Initial connect: history is the full truth
          store.setMessages(sessionId, chatMessages);
        } else {
          // Reconnect: merge history with live messages, dedup by ID
          const existingIds = new Set(existing.map((m) => m.id));
          const newFromHistory = chatMessages.filter((m) => !existingIds.has(m.id));
          if (newFromHistory.length > 0) {
            // Merge and sort by timestamp to maintain chronological order
            const merged = [...newFromHistory, ...existing].sort(
              (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
            );
            store.setMessages(sessionId, merged);
          }
        }
      }
      break;
    }
  }
}

export function connectSession(sessionId: string) {
  if (sockets.has(sessionId)) return;

  const store = useStore.getState();
  store.setConnectionStatus(sessionId, "connecting");

  const ws = new WebSocket(getWsUrl(sessionId));
  sockets.set(sessionId, ws);

  ws.onopen = () => {
    useStore.getState().setConnectionStatus(sessionId, "connected");
    // Clear any reconnect timer
    const timer = reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(sessionId);
    }
  };

  ws.onmessage = (event) => handleMessage(sessionId, event);

  ws.onclose = () => {
    sockets.delete(sessionId);
    useStore.getState().setConnectionStatus(sessionId, "disconnected");
    scheduleReconnect(sessionId);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function scheduleReconnect(sessionId: string) {
  if (reconnectTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    reconnectTimers.delete(sessionId);
    const store = useStore.getState();
    // Reconnect any active (non-archived) session
    const sdkSession = store.sdkSessions.find((s) => s.sessionId === sessionId);
    if (sdkSession && !sdkSession.archived) {
      connectSession(sessionId);
    }
  }, 2000);
  reconnectTimers.set(sessionId, timer);
}

export function disconnectSession(sessionId: string) {
  const timer = reconnectTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(sessionId);
  }
  const ws = sockets.get(sessionId);
  if (ws) {
    ws.close();
    sockets.delete(sessionId);
  }
  processedToolUseIds.delete(sessionId);
  taskCounters.delete(sessionId);
}

export function disconnectAll() {
  for (const [id] of sockets) {
    disconnectSession(id);
  }
}

export function connectAllSessions(sessions: SdkSessionInfo[]) {
  for (const s of sessions) {
    if (!s.archived) {
      connectSession(s.sessionId);
    }
  }
}

export function waitForConnection(sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      const ws = sockets.get(sessionId);
      if (ws?.readyState === WebSocket.OPEN) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
    const timeout = setTimeout(() => {
      clearInterval(check);
      reject(new Error("Connection timeout"));
    }, 10000);
  });
}

export function sendToSession(sessionId: string, msg: BrowserOutgoingMessage) {
  const ws = sockets.get(sessionId);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
