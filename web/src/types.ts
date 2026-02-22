import type {
  SessionState,
  PermissionRequest,
  ContentBlock,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  BackendType,
  McpServerDetail,
  McpServerConfig,
  CreationProgressEvent,
} from "../server/session-types.js";

export type { SessionState, PermissionRequest, ContentBlock, BrowserIncomingMessage, BrowserOutgoingMessage, BackendType, McpServerDetail, McpServerConfig, CreationProgressEvent };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  contentBlocks?: ContentBlock[];
  images?: { media_type: string; data: string }[];
  timestamp: number;
  parentToolUseId?: string | null;
  isStreaming?: boolean;
  model?: string;
  stopReason?: string | null;
}

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
  blockedBy?: string[];
}

export type ProcessStatus = "running" | "completed" | "failed" | "stopped";

export interface ProcessItem {
  /** Claude Code internal task_id (e.g., "b9d9718") */
  taskId: string;
  /** The tool_use_id from the Bash tool_use block that spawned this process */
  toolUseId: string;
  /** The shell command that was run in the background */
  command: string;
  /** Human-readable description from the Bash tool input */
  description: string;
  /** Path to the output file (from tool_result content) */
  outputFile: string;
  /** Current status */
  status: ProcessStatus;
  /** Timestamp when the process was first detected */
  startedAt: number;
  /** Timestamp when status changed to a terminal state */
  completedAt?: number;
  /** Summary text from task_notification */
  summary?: string;
}

export interface SystemProcess {
  /** OS process ID */
  pid: number;
  /** Short command name (e.g., "node", "bun", "python3") */
  command: string;
  /** Full command line with arguments */
  fullCommand: string;
  /** TCP ports this process is listening on */
  ports: number[];
}

export interface SdkSessionInfo {
  sessionId: string;
  cliSessionId?: string;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  cwd: string;
  createdAt: number;
  archived?: boolean;
  containerId?: string;
  containerName?: string;
  containerImage?: string;
  name?: string;
  backendType?: BackendType;
  gitBranch?: string;
  gitAhead?: number;
  gitBehind?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  resumeSessionAt?: string;
  forkSession?: boolean;
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
}
