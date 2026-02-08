import type { AgentType, LogLevel, TaskStatus } from "../types.js";

// ─── Request Bodies ──────────────────────────────────────────────────────────

export interface InitSessionBody {
  teamName?: string;
  cwd?: string;
  claudeDir?: string;
  claudeBinary?: string;
  env?: Record<string, string>;
  logLevel?: LogLevel;
}

export interface SpawnAgentBody {
  name: string;
  type?: AgentType;
  model?: string;
  cwd?: string;
  permissions?: string[];
  env?: Record<string, string>;
}

export interface SendMessageBody {
  message: string;
  summary?: string;
}

export interface BroadcastBody {
  message: string;
  summary?: string;
}

export interface ApprovePlanBody {
  requestId: string;
  approve?: boolean; // defaults to true
  feedback?: string;
}

export interface ApprovePermissionBody {
  requestId: string;
  approve?: boolean; // defaults to true
}

export interface CreateTaskBody {
  subject: string;
  description: string;
  activeForm?: string;
  owner?: string;
  status?: TaskStatus;
  blocks?: string[];
  blockedBy?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskBody {
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  status?: TaskStatus;
  blocks?: string[];
  blockedBy?: string[];
  metadata?: Record<string, unknown>;
}

export interface AssignTaskBody {
  agent: string;
}

// ─── Response Types ──────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
}

export interface AgentResponse {
  name: string;
  type: string;
  model?: string;
  pid?: number;
  running: boolean;
}

export interface SessionResponse {
  initialized: boolean;
  teamName: string;
}

export interface HealthResponse {
  status: "ok";
  uptime: number;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export interface UnassignedTask {
  id: string;
  subject: string;
  description: string;
  status: string;
  action: string;
}

export interface ActionsResponse {
  pending: number;
  approvals: import("./action-tracker.js").PendingApproval[];
  unassignedTasks: UnassignedTask[];
  idleAgents: import("./action-tracker.js").IdleAgent[];
}

// ─── API Options ─────────────────────────────────────────────────────────────

export interface CreateApiOptions {
  /**
   * Base path prefix for all routes (e.g. "/api/v1").
   * Defaults to "/" (no prefix).
   */
  basePath?: string;
  /**
   * CORS configuration.
   * - `true` (default): enable CORS with permissive defaults (origin: *)
   * - `false`: disable CORS entirely
   */
  cors?: boolean;
}
