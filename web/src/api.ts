import type { SdkSessionInfo } from "./types.js";
import { captureEvent, captureException } from "./analytics.js";

const BASE = "/api";

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function trackApiSuccess(method: string, path: string, durationMs: number, status: number): void {
  captureEvent("api_request_succeeded", {
    method,
    path,
    status,
    duration_ms: Math.round(durationMs),
  });
}

function trackApiFailure(
  method: string,
  path: string,
  durationMs: number,
  error: unknown,
  status?: number,
): void {
  captureEvent("api_request_failed", {
    method,
    path,
    status,
    duration_ms: Math.round(durationMs),
    error: error instanceof Error ? error.message : String(error),
  });
  captureException(error, { method, path, status });
}

async function post<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("POST", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("POST", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("POST", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function get<T = unknown>(path: string): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) {
      const apiError = new Error(res.statusText);
      trackApiFailure("GET", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("GET", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("GET", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function put<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("PUT", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("PUT", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("PUT", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function patch<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("PATCH", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("PATCH", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("PATCH", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function del<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "DELETE",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("DELETE", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("DELETE", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("DELETE", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

export interface ContainerCreateOpts {
  image?: string;
  ports?: number[];
  volumes?: string[];
  env?: Record<string, string>;
}

export interface ContainerStatus {
  available: boolean;
  version: string | null;
}

export interface CloudProviderPlan {
  provider: "modal";
  sessionId: string;
  image: string;
  cwd: string;
  mappedPorts: Array<{ containerPort: number; hostPort: number }>;
  commandPreview: string;
}

export interface CreateSessionOpts {
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  codexInternetAccess?: boolean;
  allowedTools?: string[];
  envSlug?: string;
  branch?: string;
  createBranch?: boolean;
  useWorktree?: boolean;
  backend?: "claude" | "codex";
  container?: ContainerCreateOpts;
}

export interface BackendInfo {
  id: string;
  name: string;
  available: boolean;
}

export interface BackendModelInfo {
  value: string;
  label: string;
  description: string;
}

export interface GitRepoInfo {
  repoRoot: string;
  repoName: string;
  currentBranch: string;
  defaultBranch: string;
  isWorktree: boolean;
}

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  worktreePath: string | null;
  ahead: number;
  behind: number;
}

export interface GitWorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMainWorktree: boolean;
  isDirty: boolean;
}

export interface WorktreeCreateResult {
  worktreePath: string;
  branch: string;
  isNew: boolean;
}

export interface CompanionEnv {
  name: string;
  slug: string;
  variables: Record<string, string>;
  dockerfile?: string;
  imageTag?: string;
  baseImage?: string;
  buildStatus?: "idle" | "building" | "success" | "error";
  buildError?: string;
  lastBuiltAt?: number;
  ports?: number[];
  volumes?: string[];
  initScript?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImagePullState {
  image: string;
  status: "idle" | "pulling" | "ready" | "error";
  progress: string[];
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListResult {
  path: string;
  dirs: DirEntry[];
  home: string;
  error?: string;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  isServiceMode: boolean;
  updateInProgress: boolean;
  lastChecked: number;
}

export interface UsageLimits {
  five_hour: { utilization: number; resets_at: string | null } | null;
  seven_day: { utilization: number; resets_at: string | null } | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  } | null;
}

export interface AppSettings {
  openrouterApiKeyConfigured: boolean;
  openrouterModel: string;
}

export interface GitHubPRInfo {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: { name: string; status: string; conclusion: string | null }[];
  checksSummary: { total: number; success: number; failure: number; pending: number };
  reviewThreads: { total: number; resolved: number; unresolved: number };
}

export interface PRStatusResponse {
  available: boolean;
  pr: GitHubPRInfo | null;
}

export interface CronJobInfo {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  recurring: boolean;
  backendType: "claude" | "codex";
  model: string;
  cwd: string;
  envSlug?: string;
  enabled: boolean;
  permissionMode: string;
  codexInternetAccess?: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastSessionId?: string;
  consecutiveFailures: number;
  totalRuns: number;
  nextRunAt?: number | null;
}

export interface CronJobExecution {
  sessionId: string;
  jobId: string;
  startedAt: number;
  completedAt?: number;
  success?: boolean;
  error?: string;
  costUsd?: number;
}

export interface SavedPrompt {
  id: string;
  name: string;
  content: string;
  scope: "global" | "project";
  projectPath?: string;
  createdAt: number;
  updatedAt: number;
}

// ─── SSE Session Creation ────────────────────────────────────────────────────

export interface CreationProgressEvent {
  step: string;
  label: string;
  status: "in_progress" | "done" | "error";
  detail?: string;
}

export interface CreateSessionStreamResult {
  sessionId: string;
  state: string;
  cwd: string;
}

/**
 * Create a session with real-time progress streaming via SSE.
 * Uses fetch + ReadableStream (EventSource is GET-only, this is POST).
 */
export async function createSessionStream(
  opts: CreateSessionOpts | undefined,
  onProgress: (progress: CreationProgressEvent) => void,
): Promise<CreateSessionStreamResult> {
  const res = await fetch(`${BASE}/sessions/create-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: CreateSessionStreamResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events: split on double newlines
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      let eventType = "";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (!data) continue;

      const parsed = JSON.parse(data);
      if (eventType === "progress") {
        onProgress(parsed as CreationProgressEvent);
      } else if (eventType === "done") {
        result = parsed as CreateSessionStreamResult;
      } else if (eventType === "error") {
        throw new Error((parsed as { error: string }).error || "Session creation failed");
      }
    }
  }

  if (!result) {
    throw new Error("Stream ended without session creation result");
  }

  return result;
}

export const api = {
  createSession: (opts?: CreateSessionOpts) =>
    post<{ sessionId: string; state: string; cwd: string }>(
      "/sessions/create",
      opts,
    ),

  listSessions: () => get<SdkSessionInfo[]>("/sessions"),

  killSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/kill`),

  deleteSession: (sessionId: string) =>
    del(`/sessions/${encodeURIComponent(sessionId)}`),

  relaunchSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/relaunch`),

  archiveSession: (sessionId: string, opts?: { force?: boolean }) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/archive`, opts),

  unarchiveSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/unarchive`),

  renameSession: (sessionId: string, name: string) =>
    patch<{ ok: boolean; name: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/name`,
      { name },
    ),

  listDirs: (path?: string) =>
    get<DirListResult>(
      `/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),

  getHome: () => get<{ home: string; cwd: string }>("/fs/home"),

  // Environments
  listEnvs: () => get<CompanionEnv[]>("/envs"),
  getEnv: (slug: string) =>
    get<CompanionEnv>(`/envs/${encodeURIComponent(slug)}`),
  createEnv: (name: string, variables: Record<string, string>, docker?: {
    dockerfile?: string;
    baseImage?: string;
    ports?: number[];
    volumes?: string[];
    initScript?: string;
  }) =>
    post<CompanionEnv>("/envs", { name, variables, ...docker }),
  updateEnv: (
    slug: string,
    data: {
      name?: string;
      variables?: Record<string, string>;
      dockerfile?: string;
      baseImage?: string;
      ports?: number[];
      volumes?: string[];
      initScript?: string;
    },
  ) => put<CompanionEnv>(`/envs/${encodeURIComponent(slug)}`, data),
  deleteEnv: (slug: string) => del(`/envs/${encodeURIComponent(slug)}`),

  // Environment Docker builds
  buildEnvImage: (slug: string) =>
    post<{ ok: boolean; imageTag: string }>(`/envs/${encodeURIComponent(slug)}/build`),
  getEnvBuildStatus: (slug: string) =>
    get<{ buildStatus: string; buildError?: string; lastBuiltAt?: number; imageTag?: string }>(
      `/envs/${encodeURIComponent(slug)}/build-status`,
    ),
  buildBaseImage: () =>
    post<{ ok: boolean; tag: string }>("/docker/build-base"),
  getBaseImageStatus: () =>
    get<{ exists: boolean; tag: string }>("/docker/base-image"),

  // Settings
  getSettings: () => get<AppSettings>("/settings"),
  updateSettings: (data: { openrouterApiKey?: string; openrouterModel?: string }) =>
    put<AppSettings>("/settings", data),

  // Git operations
  getRepoInfo: (path: string) =>
    get<GitRepoInfo>(`/git/repo-info?path=${encodeURIComponent(path)}`),
  listBranches: (repoRoot: string) =>
    get<GitBranchInfo[]>(
      `/git/branches?repoRoot=${encodeURIComponent(repoRoot)}`,
    ),
  gitFetch: (repoRoot: string) =>
    post<{ success: boolean; output: string }>("/git/fetch", { repoRoot }),
  gitPull: (cwd: string) =>
    post<{
      success: boolean;
      output: string;
      git_ahead: number;
      git_behind: number;
    }>("/git/pull", { cwd }),

  // Git worktrees
  listWorktrees: (repoRoot: string) =>
    get<GitWorktreeInfo[]>(
      `/git/worktrees?repoRoot=${encodeURIComponent(repoRoot)}`,
    ),
  createWorktree: (
    repoRoot: string,
    branch: string,
    opts?: { baseBranch?: string; createBranch?: boolean },
  ) =>
    post<WorktreeCreateResult>("/git/worktree", {
      repoRoot,
      branch,
      ...opts,
    }),
  removeWorktree: (repoRoot: string, worktreePath: string, force?: boolean) =>
    del("/git/worktree", { repoRoot, worktreePath, force }),

  // GitHub PR status
  getPRStatus: (cwd: string, branch: string) =>
    get<PRStatusResponse>(
      `/git/pr-status?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(branch)}`,
    ),

  // Backends
  getBackends: () => get<BackendInfo[]>("/backends"),
  getBackendModels: (backendId: string) =>
    get<BackendModelInfo[]>(`/backends/${encodeURIComponent(backendId)}/models`),

  // Containers
  getContainerStatus: () => get<ContainerStatus>("/containers/status"),
  getContainerImages: () => get<string[]>("/containers/images"),

  // Image pull manager
  getImageStatus: (tag: string) =>
    get<ImagePullState>(`/images/${encodeURIComponent(tag)}/status`),
  pullImage: (tag: string) =>
    post<{ ok: boolean; state: ImagePullState }>(`/images/${encodeURIComponent(tag)}/pull`),
  getCloudProviderPlan: (provider: "modal", cwd: string, sessionId: string) =>
    get<CloudProviderPlan>(
      `/cloud/providers/${encodeURIComponent(provider)}/plan?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`,
    ),

  // Editor
  startEditor: (sessionId: string) =>
    post<{ url: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/editor/start`,
    ),

  // Editor filesystem
  getFileTree: (path: string) =>
    get<{ path: string; tree: TreeNode[] }>(
      `/fs/tree?path=${encodeURIComponent(path)}`,
    ),
  readFile: (path: string) =>
    get<{ path: string; content: string }>(
      `/fs/read?path=${encodeURIComponent(path)}`,
    ),
  writeFile: (path: string, content: string) =>
    put<{ ok: boolean; path: string }>("/fs/write", { path, content }),
  getFileDiff: (path: string, base?: "last-commit" | "default-branch") =>
    get<{ path: string; diff: string }>(
      `/fs/diff?path=${encodeURIComponent(path)}${base ? `&base=${encodeURIComponent(base)}` : ""}`,
    ),
  getClaudeMdFiles: (cwd: string) =>
    get<{ cwd: string; files: { path: string; content: string }[] }>(
      `/fs/claude-md?cwd=${encodeURIComponent(cwd)}`,
    ),
  saveClaudeMd: (path: string, content: string) =>
    put<{ ok: boolean; path: string }>("/fs/claude-md", { path, content }),

  // Usage limits
  getUsageLimits: () => get<UsageLimits>("/usage-limits"),
  getSessionUsageLimits: (sessionId: string) =>
    get<UsageLimits>(`/sessions/${encodeURIComponent(sessionId)}/usage-limits`),

  // Terminal
  spawnTerminal: (cwd: string, cols?: number, rows?: number, opts?: { containerId?: string }) =>
    post<{ terminalId: string }>("/terminal/spawn", { cwd, cols, rows, containerId: opts?.containerId }),
  killTerminal: (terminalId: string) =>
    post<{ ok: boolean }>("/terminal/kill", { terminalId }),
  getTerminal: (terminalId?: string) =>
    get<{ active: boolean; terminalId?: string; cwd?: string }>(
      terminalId
        ? `/terminal?terminalId=${encodeURIComponent(terminalId)}`
        : "/terminal",
    ),

  // Update checking
  checkForUpdate: () => get<UpdateInfo>("/update-check"),
  forceCheckForUpdate: () => post<UpdateInfo>("/update-check"),
  triggerUpdate: () =>
    post<{ ok: boolean; message: string }>("/update"),

  // Cron jobs
  listCronJobs: () => get<CronJobInfo[]>("/cron/jobs"),
  getCronJob: (id: string) => get<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}`),
  createCronJob: (data: Partial<CronJobInfo>) => post<CronJobInfo>("/cron/jobs", data),
  updateCronJob: (id: string, data: Partial<CronJobInfo>) =>
    put<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}`, data),
  deleteCronJob: (id: string) => del(`/cron/jobs/${encodeURIComponent(id)}`),
  toggleCronJob: (id: string) => post<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}/toggle`),
  runCronJob: (id: string) => post(`/cron/jobs/${encodeURIComponent(id)}/run`),
  getCronJobExecutions: (id: string) =>
    get<CronJobExecution[]>(`/cron/jobs/${encodeURIComponent(id)}/executions`),

  // Cross-session messaging
  sendSessionMessage: (sessionId: string, content: string) =>
    post<{ ok: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/message`, { content }),

  // Saved prompts
  listPrompts: (cwd?: string, scope?: "global" | "project" | "all") => {
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    if (scope) params.set("scope", scope);
    const query = params.toString();
    return get<SavedPrompt[]>(`/prompts${query ? `?${query}` : ""}`);
  },
  createPrompt: (data: { name: string; content: string; scope: "global" | "project"; cwd?: string }) =>
    post<SavedPrompt>("/prompts", data),
  updatePrompt: (id: string, data: { name?: string; content?: string }) =>
    put<SavedPrompt>(`/prompts/${encodeURIComponent(id)}`, data),
  deletePrompt: (id: string) =>
    del<{ ok: boolean }>(`/prompts/${encodeURIComponent(id)}`),
};
