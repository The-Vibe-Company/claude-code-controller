import type {
  PermissionAutomationDecision,
  PluginDefinition,
  PluginEvent,
  PluginEventOf,
  PluginEventResult,
  PluginInsight,
  SoundVariant,
} from "./types.js";

interface NotificationsPluginConfig {
  onSessionCreated: boolean;
  onSessionEnded: boolean;
  onResultSuccess: boolean;
  onResultError: boolean;
  onPermissionRequest: boolean;
  onPermissionResponse: boolean;
  onToolLifecycle: boolean;
}

interface PermissionRule {
  id: string;
  enabled: boolean;
  backendType: "claude" | "codex" | "any";
  toolName?: string;
  commandContains?: string;
  filePathContains?: string;
  action: "allow" | "deny";
  message?: string;
}

interface PermissionAutomationPluginConfig {
  rules: PermissionRule[];
}

function asBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function normalizeNotificationsConfig(input: unknown): NotificationsPluginConfig {
  const src = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return {
    onSessionCreated: asBoolean(src.onSessionCreated, false),
    onSessionEnded: asBoolean(src.onSessionEnded, true),
    onResultSuccess: asBoolean(src.onResultSuccess, false),
    onResultError: asBoolean(src.onResultError, true),
    onPermissionRequest: asBoolean(src.onPermissionRequest, true),
    onPermissionResponse: asBoolean(src.onPermissionResponse, true),
    onToolLifecycle: asBoolean(src.onToolLifecycle, false),
  };
}

function normalizePermissionAutomationConfig(input: unknown): PermissionAutomationPluginConfig {
  const src = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rulesRaw = Array.isArray(src.rules) ? src.rules : [];
  const rules: PermissionRule[] = [];

  for (const item of rulesRaw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const action = row.action === "allow" || row.action === "deny" ? row.action : null;
    if (!action) continue;

    const backendType = row.backendType === "claude" || row.backendType === "codex"
      ? row.backendType
      : "any";

    rules.push({
      id: asString(row.id) || `rule-${rules.length + 1}`,
      enabled: asBoolean(row.enabled, true),
      backendType,
      toolName: asString(row.toolName),
      commandContains: asString(row.commandContains),
      filePathContains: asString(row.filePathContains),
      action,
      message: asString(row.message),
    });
  }

  return { rules };
}

interface InsightCaps {
  toast?: boolean;
  sound?: boolean | SoundVariant;
  desktop?: boolean;
}

function buildInsight(
  pluginId: string,
  event: PluginEvent,
  level: PluginInsight["level"],
  title: string,
  message: string,
  sessionId?: string,
  caps?: InsightCaps,
): PluginInsight {
  return {
    id: `${pluginId}-${event.meta.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    plugin_id: pluginId,
    title,
    message,
    level,
    timestamp: event.meta.timestamp,
    session_id: sessionId,
    event_name: event.name,
    ...caps,
  };
}

export const notificationsPlugin: PluginDefinition<NotificationsPluginConfig> = {
  id: "notifications",
  name: "Session Notifications",
  version: "2.0.0",
  description: "Generates plugin notifications for session and execution events.",
  events: [
    "session.created",
    "session.killed",
    "session.archived",
    "session.deleted",
    "result.received",
    "permission.requested",
    "permission.responded",
    "tool.started",
    "tool.finished",
  ],
  priority: 50,
  blocking: true,
  timeoutMs: 1000,
  failPolicy: "continue",
  defaultEnabled: true,
  defaultConfig: {
    onSessionCreated: false,
    onSessionEnded: true,
    onResultSuccess: false,
    onResultError: true,
    onPermissionRequest: true,
    onPermissionResponse: true,
    onToolLifecycle: false,
  },
  validateConfig: normalizeNotificationsConfig,
  onEvent: (event, config): PluginEventResult | void => {
    if (event.name === "session.created") {
      if (!config.onSessionCreated) return;
      const payload = (event as PluginEventOf<"session.created">).data;
      return {
        insights: [
          buildInsight("notifications", event, "info", "Session created", `Session ${payload.session.session_id} started.`, payload.session.session_id, { toast: true, sound: true, desktop: true }),
        ],
      };
    }

    if (event.name === "session.killed" || event.name === "session.archived" || event.name === "session.deleted") {
      if (!config.onSessionEnded) return;
      const payload = (event as PluginEventOf<"session.killed" | "session.archived" | "session.deleted">).data;
      return {
        insights: [
          buildInsight("notifications", event, "warning", "Session ended", `Event ${event.name} on ${payload.sessionId}.`, payload.sessionId, { toast: true, sound: true, desktop: true }),
        ],
      };
    }

    if (event.name === "result.received") {
      const payload = (event as PluginEventOf<"result.received">).data;
      if (!payload.success && !config.onResultError) return;
      if (payload.success && !config.onResultSuccess) return;
      return {
        insights: [
          buildInsight(
            "notifications",
            event,
            payload.success ? "success" : "error",
            payload.success ? "Execution completed" : "Execution error",
            payload.success ? `Result received (${payload.numTurns} turns).` : (payload.errorSummary || "Unknown error"),
            payload.sessionId,
            { toast: true, sound: true, desktop: !payload.success },
          ),
        ],
      };
    }

    if (event.name === "permission.requested") {
      if (!config.onPermissionRequest) return;
      const payload = (event as PluginEventOf<"permission.requested">).data;
      return {
        insights: [
          buildInsight(
            "notifications",
            event,
            "info",
            "Permission requested",
            `${payload.permission.tool_name} is waiting for a decision.`,
            payload.sessionId,
            { toast: true, sound: true, desktop: true },
          ),
        ],
      };
    }

    if (event.name === "permission.responded") {
      if (!config.onPermissionResponse) return;
      const payload = (event as PluginEventOf<"permission.responded">).data;
      return {
        insights: [
          buildInsight(
            "notifications",
            event,
            payload.behavior === "allow" ? "success" : "warning",
            "Permission responded",
            `${payload.requestId}: ${payload.behavior}${payload.automated ? " (automated)" : ""}`,
            payload.sessionId,
            { toast: true },
          ),
        ],
      };
    }

    if ((event.name === "tool.started" || event.name === "tool.finished") && config.onToolLifecycle) {
      const payload = (event as PluginEventOf<"tool.started" | "tool.finished">).data;
      return {
        insights: [
          buildInsight(
            "notifications",
            event,
            "info",
            event.name === "tool.started" ? "Tool started" : "Tool finished",
            `tool_use_id=${payload.toolUseId}`,
            payload.sessionId,
            { toast: true },
          ),
        ],
      };
    }

    return;
  },
};

function matchesRule(event: PluginEventOf<"permission.requested">, rule: PermissionRule): boolean {
  if (!rule.enabled) return false;
  if (rule.backendType !== "any" && rule.backendType !== event.data.backendType) return false;
  if (rule.toolName && rule.toolName !== event.data.permission.tool_name) return false;

  const normalized = event.data.toolInputNormalized;
  const command = normalized.command || "";
  const filePath = normalized.filePath || "";

  if (rule.commandContains && !command.includes(rule.commandContains)) return false;
  if (rule.filePathContains && !filePath.includes(rule.filePathContains)) return false;

  return true;
}

export const permissionAutomationPlugin: PluginDefinition<PermissionAutomationPluginConfig> = {
  id: "permission-automation",
  name: "Permission Automation",
  version: "2.0.0",
  description: "Automates allow/deny permissions with explicit rules.",
  events: ["permission.requested"],
  priority: 1000,
  blocking: true,
  timeoutMs: 500,
  failPolicy: "abort_current_action",
  defaultEnabled: false,
  defaultConfig: {
    rules: [],
  },
  validateConfig: normalizePermissionAutomationConfig,
  onEvent: (event, config): PluginEventResult | void => {
    if (event.name !== "permission.requested") return;
    const permissionEvent = event as PluginEventOf<"permission.requested">;

    for (const rule of config.rules) {
      if (!matchesRule(permissionEvent, rule)) continue;

      const decision: PermissionAutomationDecision = {
        behavior: rule.action,
        message: rule.message || `Auto decision (${rule.id})`,
        pluginId: "permission-automation",
      };

      return {
        permissionDecision: decision,
        insights: [
          buildInsight(
            "permission-automation",
            event,
            rule.action === "allow" ? "success" : "warning",
            "Permission auto-handled",
            `${permissionEvent.data.permission.tool_name}: ${rule.action} via rule ${rule.id}.`,
            permissionEvent.data.sessionId,
            { toast: true },
          ),
        ],
      };
    }

    return;
  },
};

export function getBuiltinPlugins(): Array<PluginDefinition<any>> {
  return [notificationsPlugin, permissionAutomationPlugin];
}
