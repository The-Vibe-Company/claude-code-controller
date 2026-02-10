import type {
  SessionState,
  PermissionRequest,
  ContentBlock,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
} from "../server/session-types.js";

export type { SessionState, PermissionRequest, ContentBlock, BrowserIncomingMessage, BrowserOutgoingMessage };

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

export interface SdkSessionInfo {
  sessionId: string;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  cwd: string;
  createdAt: number;
  archived?: boolean;
  isWorktree?: boolean;
  repoRoot?: string;
  branch?: string;
  actualBranch?: string;
  name?: string;
  projectKey?: string;
}

/** Merged session data for sidebar display */
export interface SidebarSession {
  id: string;
  model?: string;
  cwd?: string;
  gitBranch?: string;
  isWorktree: boolean;
  gitAhead: number;
  gitBehind: number;
  linesAdded: number;
  linesRemoved: number;
  isConnected: boolean;
  status: string | null;
  sdkState?: string;
  createdAt?: number;
  archived?: boolean;
  projectKey?: string;
}

/** Project group for sidebar rendering */
export interface SidebarProject {
  key: string;
  name: string;
  sessions: SidebarSession[];
  activeSessions: number;
  totalCost: number;
}
