import type { BackendType, CLIResultMessage, PermissionRequest, SessionState } from "../session-types.js";

export type PluginEventName =
  | "user.message.before_send"
  | "session.created"
  | "session.killed"
  | "session.archived"
  | "session.deleted"
  | "session.connected"
  | "session.disconnected"
  | "session.status.changed"
  | "session.name.updated"
  | "user.message.sent"
  | "message.assistant"
  | "result.received"
  | "permission.requested"
  | "permission.responded"
  | "tool.started"
  | "tool.finished"
  | "mcp.status.changed";

export interface PluginEventMap {
  "user.message.before_send": {
    sessionId: string;
    backendType: BackendType;
    state: SessionState;
    content: string;
    images?: Array<{ media_type: string; data: string }>;
  };
  "session.created": { session: SessionState };
  "session.killed": { sessionId: string };
  "session.archived": { sessionId: string };
  "session.deleted": { sessionId: string };
  "session.connected": { sessionId: string; backendType: BackendType };
  "session.disconnected": { sessionId: string; backendType: BackendType };
  "session.status.changed": {
    sessionId: string;
    backendType: BackendType;
    status: "idle" | "running" | "compacting" | null;
  };
  "session.name.updated": { sessionId: string; name: string };
  "user.message.sent": {
    sessionId: string;
    backendType: BackendType;
    content: string;
    hasImages: boolean;
  };
  "message.assistant": {
    sessionId: string;
    backendType: BackendType;
    text: string;
    hasToolUse: boolean;
    toolNames: string[];
  };
  "result.received": {
    sessionId: string;
    backendType: BackendType;
    result: CLIResultMessage;
    success: boolean;
    durationMs: number;
    costUsd: number;
    numTurns: number;
    errorSummary?: string;
  };
  "permission.requested": {
    sessionId: string;
    permission: PermissionRequest;
    backendType: BackendType;
    state: SessionState;
    permissionMode: string;
    requestHash: string;
    toolInputNormalized: {
      command?: string;
      filePath?: string;
    };
  };
  "permission.responded": {
    sessionId: string;
    backendType: BackendType;
    requestId: string;
    behavior: "allow" | "deny";
    automated: boolean;
    pluginId?: string;
    message?: string;
  };
  "tool.started": {
    sessionId: string;
    backendType: BackendType;
    toolUseId: string;
    toolName: string;
    parentToolUseId: string | null;
  };
  "tool.finished": {
    sessionId: string;
    backendType: BackendType;
    toolUseId: string;
  };
  "mcp.status.changed": {
    sessionId: string;
    backendType: BackendType;
    servers: Array<{ name: string; status: string }>;
  };
}

export type PluginEventSource =
  | "routes"
  | "ws-bridge"
  | "codex-adapter"
  | "plugin-manager";

export interface PluginEventMeta {
  eventId: string;
  eventVersion: 2;
  timestamp: number;
  source: PluginEventSource;
  sessionId?: string;
  backendType?: BackendType;
  correlationId?: string;
}

export type PluginEventOf<K extends PluginEventName> = {
  name: K;
  meta: PluginEventMeta;
  data: PluginEventMap[K];
};

export type PluginEvent = {
  [K in PluginEventName]: PluginEventOf<K>;
}[PluginEventName];

export type PluginInsightLevel = "info" | "success" | "warning" | "error";

export type SoundVariant = "default" | "success" | "error" | "warning" | "info";

export interface PluginInsight {
  id: string;
  plugin_id: string;
  title: string;
  message: string;
  level: PluginInsightLevel;
  timestamp: number;
  session_id?: string;
  event_name?: PluginEventName;

  // Notification capabilities — any plugin can opt into these
  /** Show a toast notification in the UI. */
  toast?: boolean;
  /** Play a sound. true = level-based variant, or specify an explicit variant. */
  sound?: boolean | SoundVariant;
  /** Show a native desktop notification (only when tab is unfocused). */
  desktop?: boolean;
}

export interface PermissionAutomationDecision {
  behavior: "allow" | "deny";
  message?: string;
  updated_input?: Record<string, unknown>;
  pluginId?: string;
}

export interface PluginEventResult {
  insights?: PluginInsight[];
  permissionDecision?: PermissionAutomationDecision;
  userMessageMutation?: {
    content?: string;
    images?: Array<{ media_type: string; data: string }>;
    blocked?: boolean;
    message?: string;
    pluginId?: string;
  };
  /** Optional patch merged into event.data for downstream plugins in the same emit chain. */
  eventDataPatch?: Record<string, unknown>;
}

export type PluginFailPolicy = "continue" | "abort_current_action";

export type PluginEventSubscription = PluginEventName | "*";

export interface PluginDefinition<TConfig = unknown> {
  id: string;
  name: string;
  version: string;
  description: string;
  events: PluginEventSubscription[];
  priority: number;
  blocking: boolean;
  timeoutMs?: number;
  failPolicy?: PluginFailPolicy;
  defaultEnabled: boolean;
  defaultConfig: TConfig;
  validateConfig?: (input: unknown) => TConfig;
  onEvent: (event: PluginEvent, config: TConfig) => Promise<PluginEventResult | void> | PluginEventResult | void;
}

export interface PluginRuntimeInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  events: PluginEventSubscription[];
  priority: number;
  blocking: boolean;
  timeoutMs: number;
  failPolicy: PluginFailPolicy;
  enabled: boolean;
  config: unknown;
}

export interface PluginStateFile {
  updatedAt: number;
  enabled: Record<string, boolean>;
  config: Record<string, unknown>;
}
