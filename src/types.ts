import { EventEmitter } from "node:events";

// ─── Inbox ───────────────────────────────────────────────────────────────────

export interface InboxMessage {
  from: string;
  text: string;
  timestamp: string; // ISO date string
  color?: string;
  read: boolean;
  summary?: string;
}

// Structured message types that can appear inside InboxMessage.text as JSON
export type StructuredMessage =
  | TaskAssignmentMessage
  | ShutdownRequestMessage
  | ShutdownApprovedMessage
  | IdleNotificationMessage
  | PlanApprovalRequestMessage
  | PlanApprovalResponseMessage
  | PermissionRequestMessage
  | PermissionResponseMessage
  | PlainTextMessage;

export interface TaskAssignmentMessage {
  type: "task_assignment";
  taskId: string;
  subject: string;
  description: string;
  assignedBy: string;
  timestamp: string;
}

export interface ShutdownRequestMessage {
  type: "shutdown_request";
  requestId: string;
  from: string;
  reason?: string;
  timestamp: string;
}

export interface ShutdownApprovedMessage {
  type: "shutdown_approved";
  requestId: string;
  from: string;
  timestamp: string;
  paneId?: string;
  backendType?: string;
}

export interface IdleNotificationMessage {
  type: "idle_notification";
  from: string;
  timestamp: string;
  idleReason: string;
}

export interface PlanApprovalRequestMessage {
  type: "plan_approval_request";
  requestId: string;
  from: string;
  planContent?: string;
  timestamp: string;
}

export interface PlanApprovalResponseMessage {
  type: "plan_approval_response";
  requestId: string;
  from: string;
  approved: boolean;
  feedback?: string;
  timestamp: string;
}

export interface PermissionRequestMessage {
  type: "permission_request";
  requestId: string;
  from: string;
  toolName: string;
  toolUseId?: string;
  description: string;
  input?: unknown;
  permissionSuggestions?: string[];
  timestamp: string;
}

export interface PermissionResponseMessage {
  type: "permission_response";
  requestId: string;
  from: string;
  approved: boolean;
  timestamp: string;
}

export interface PlainTextMessage {
  type: "plain_text";
  text: string;
}

// ─── Team ────────────────────────────────────────────────────────────────────

export interface TeamConfig {
  name: string;
  description?: string;
  createdAt: number; // epoch ms
  leadAgentId: string; // format: name@teamName
  leadSessionId: string; // UUID
  members: TeamMember[];
}

export interface TeamMember {
  agentId: string; // format: name@teamName
  name: string;
  agentType: string;
  model?: string;
  joinedAt: number; // epoch ms
  tmuxPaneId?: string;
  cwd: string;
  subscriptions?: string[];
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export interface TaskFile {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  owner?: string;
  status: TaskStatus;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

export type TaskStatus = "pending" | "in_progress" | "completed";

// ─── Controller Options ──────────────────────────────────────────────────────

export type AgentType =
  | "general-purpose"
  | "Bash"
  | "Explore"
  | "Plan"
  | string;

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "delegate";

export interface SpawnAgentOptions {
  name: string;
  type?: AgentType;
  model?: string; // "sonnet" | "opus" | "haiku" | full model id
  cwd?: string;
  prompt?: string;
  permissions?: string[]; // e.g. ["Bash", "Read", "Write"]
  permissionMode?: PermissionMode;
  /** Environment variables to inject into the agent's process */
  env?: Record<string, string>;
}

export interface ControllerOptions {
  teamName?: string;
  cwd?: string;
  claudeBinary?: string; // path to claude binary, default "claude"
  /**
   * Override where Claude Code stores teams/inboxes/tasks.
   * Defaults to "~/.claude".
   */
  claudeDir?: string;
  logger?: Logger;
  /** Default environment variables for all spawned agents */
  env?: Record<string, string>;
}

export interface ReceiveOptions {
  timeout?: number; // ms, default 60_000
  pollInterval?: number; // ms, default 500
  /** If true, return all unread messages, not just the first one */
  all?: boolean;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export interface ControllerEvents {
  message: [agentName: string, message: InboxMessage];
  idle: [agentName: string];
  "shutdown:approved": [agentName: string, message: ShutdownApprovedMessage];
  "plan:approval_request": [agentName: string, message: PlanApprovalRequestMessage];
  "permission:request": [agentName: string, message: PermissionRequestMessage];
  "task:completed": [task: TaskFile];
  "agent:spawned": [agentName: string, pid: number];
  "agent:exited": [agentName: string, code: number | null];
  error: [error: Error];
}

// ─── Logger ──────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}
