import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────────────

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
  /** The conceptual branch the user selected */
  branch: string;
  /** The actual git branch in the worktree (may be e.g. `main-wt-2` for duplicate sessions) */
  actualBranch: string;
  isNew: boolean;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const WORKTREES_BASE = join(homedir(), ".companion", "worktrees");

function sanitizeBranch(branch: string): string {
  return branch.replace(/\//g, "--");
}

function worktreeDir(repoName: string, branch: string): string {
  return join(WORKTREES_BASE, repoName, sanitizeBranch(branch));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function git(cmd: string, cwd: string, env?: Record<string, string>): string {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : undefined,
  }).trim();
}

function gitSafe(cmd: string, cwd: string, env?: Record<string, string>): string | null {
  try {
    return git(cmd, cwd, env);
  } catch {
    return null;
  }
}

// ─── Functions ──────────────────────────────────────────────────────────────

export function getRepoInfo(cwd: string, options?: { env?: Record<string, string> }): GitRepoInfo | null {
  const env = options?.env;
  const repoRoot = gitSafe("rev-parse --show-toplevel", cwd, env);
  if (!repoRoot) return null;

  const currentBranch = gitSafe("rev-parse --abbrev-ref HEAD", cwd, env) || "HEAD";
  const gitDir = gitSafe("rev-parse --git-dir", cwd, env) || "";
  // A linked worktree's .git dir is inside the main repo's .git/worktrees/
  const isWorktree = gitDir.includes("/worktrees/");

  const defaultBranch = resolveDefaultBranch(repoRoot, env);

  return {
    repoRoot,
    repoName: basename(repoRoot),
    currentBranch,
    defaultBranch,
    isWorktree,
  };
}

function resolveDefaultBranch(repoRoot: string, env?: Record<string, string>): string {
  // Try origin HEAD
  const originRef = gitSafe("symbolic-ref refs/remotes/origin/HEAD", repoRoot, env);
  if (originRef) {
    return originRef.replace("refs/remotes/origin/", "");
  }
  // Fallback: check if main or master exists
  const branches = gitSafe("branch --list main master", repoRoot, env) || "";
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  // Last resort
  return "main";
}

export function listBranches(repoRoot: string, options?: { env?: Record<string, string> }): GitBranchInfo[] {
  const env = options?.env;
  // Get worktree mappings first
  const worktrees = listWorktrees(repoRoot, { env });
  const worktreeByBranch = new Map<string, string>();
  for (const wt of worktrees) {
    if (wt.branch) worktreeByBranch.set(wt.branch, wt.path);
  }

  const result: GitBranchInfo[] = [];

  // Local branches
  const localRaw = gitSafe(
    "for-each-ref '--format=%(refname:short)%09%(HEAD)' refs/heads/",
    repoRoot,
    env,
  );
  if (localRaw) {
    for (const line of localRaw.split("\n")) {
      if (!line.trim()) continue;
      const [name, head] = line.split("\t");
      const isCurrent = head?.trim() === "*";
      const { ahead, behind } = getBranchStatus(repoRoot, name, { env });
      result.push({
        name,
        isCurrent,
        isRemote: false,
        worktreePath: worktreeByBranch.get(name) || null,
        ahead,
        behind,
      });
    }
  }

  // Remote branches (only those without a local counterpart)
  const localNames = new Set(result.map((b) => b.name));
  const remoteRaw = gitSafe(
    "for-each-ref '--format=%(refname:short)' refs/remotes/origin/",
    repoRoot,
    env,
  );
  if (remoteRaw) {
    for (const line of remoteRaw.split("\n")) {
      const full = line.trim();
      if (!full || full === "origin/HEAD") continue;
      const name = full.replace("origin/", "");
      if (localNames.has(name)) continue;
      result.push({
        name,
        isCurrent: false,
        isRemote: true,
        worktreePath: null,
        ahead: 0,
        behind: 0,
      });
    }
  }

  return result;
}

export function listWorktrees(repoRoot: string, options?: { env?: Record<string, string> }): GitWorktreeInfo[] {
  const env = options?.env;
  const raw = gitSafe("worktree list --porcelain", repoRoot, env);
  if (!raw) return [];

  const worktrees: GitWorktreeInfo[] = [];
  let current: Partial<GitWorktreeInfo> = {};

  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        worktrees.push(current as GitWorktreeInfo);
      }
      current = { path: line.slice(9), isDirty: false, isMainWorktree: false };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.isMainWorktree = true;
    } else if (line === "") {
      // End of entry — check if main worktree (first one is always main)
      if (worktrees.length === 0 && current.path) {
        current.isMainWorktree = true;
      }
    }
  }
  // Push last entry
  if (current.path) {
    if (worktrees.length === 0) current.isMainWorktree = true;
    worktrees.push(current as GitWorktreeInfo);
  }

  // Check dirty status for each worktree
  for (const wt of worktrees) {
    wt.isDirty = isWorktreeDirty(wt.path, { env });
  }

  return worktrees;
}

export function ensureWorktree(
  repoRoot: string,
  branchName: string,
  options?: { baseBranch?: string; createBranch?: boolean; forceNew?: boolean; env?: Record<string, string> },
): WorktreeCreateResult {
  const env = options?.env;
  const repoName = basename(repoRoot);

  // Check if a worktree already exists for this branch
  const existing = listWorktrees(repoRoot, { env });
  const found = existing.find((wt) => wt.branch === branchName);

  if (found && !options?.forceNew) {
    // Don't reuse the main worktree — it's the original repo checkout
    if (!found.isMainWorktree) {
      return { worktreePath: found.path, branch: branchName, actualBranch: branchName, isNew: false };
    }
  }

  // Find a unique path: append random 4-digit suffix if the base path is taken
  const basePath = worktreeDir(repoName, branchName);
  let targetPath = basePath;
  for (let attempt = 0; attempt < 100 && existsSync(targetPath); attempt++) {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    targetPath = `${basePath}-${suffix}`;
  }
  if (existsSync(targetPath)) {
    targetPath = `${basePath}-${Date.now()}`;
  }

  // Ensure parent directory exists
  mkdirSync(join(WORKTREES_BASE, repoName), { recursive: true });

  // A worktree already exists for this branch — create a new uniquely-named
  // branch so multiple sessions can work on the same branch independently.
  if (found) {
    const commitHash = git("rev-parse HEAD", found.path, env);
    const uniqueBranch = generateUniqueWorktreeBranch(repoRoot, branchName, { env });
    git(`worktree add -b ${uniqueBranch} "${targetPath}" ${commitHash}`, repoRoot, env);
    return { worktreePath: targetPath, branch: branchName, actualBranch: uniqueBranch, isNew: false };
  }

  // Check if branch already exists locally or on remote
  const branchExists =
    gitSafe(`rev-parse --verify refs/heads/${branchName}`, repoRoot, env) !== null;
  const remoteBranchExists =
    gitSafe(`rev-parse --verify refs/remotes/origin/${branchName}`, repoRoot, env) !== null;

  if (branchExists) {
    if (options?.forceNew) {
      // Create a uniquely-named branch so multiple sessions can work independently
      const commitHash = git(`rev-parse refs/heads/${branchName}`, repoRoot, env);
      const uniqueBranch = generateUniqueWorktreeBranch(repoRoot, branchName, { env });
      git(`worktree add -b ${uniqueBranch} "${targetPath}" ${commitHash}`, repoRoot, env);
      return { worktreePath: targetPath, branch: branchName, actualBranch: uniqueBranch, isNew: false };
    }
    // Worktree add with existing local branch
    git(`worktree add "${targetPath}" ${branchName}`, repoRoot, env);
    return { worktreePath: targetPath, branch: branchName, actualBranch: branchName, isNew: false };
  }

  if (remoteBranchExists) {
    if (options?.forceNew) {
      const uniqueBranch = generateUniqueWorktreeBranch(repoRoot, branchName, { env });
      git(`worktree add -b ${uniqueBranch} "${targetPath}" origin/${branchName}`, repoRoot, env);
      return { worktreePath: targetPath, branch: branchName, actualBranch: uniqueBranch, isNew: false };
    }
    // Create local tracking branch from remote
    git(`worktree add -b ${branchName} "${targetPath}" origin/${branchName}`, repoRoot, env);
    return { worktreePath: targetPath, branch: branchName, actualBranch: branchName, isNew: false };
  }

  if (options?.createBranch !== false) {
    // Create new branch from base
    const base = options?.baseBranch || resolveDefaultBranch(repoRoot, env);
    git(`worktree add -b ${branchName} "${targetPath}" ${base}`, repoRoot, env);
    return { worktreePath: targetPath, branch: branchName, actualBranch: branchName, isNew: true };
  }

  throw new Error(`Branch "${branchName}" does not exist and createBranch is false`);
}

/**
 * Generate a unique branch name for a companion-managed worktree.
 * Pattern: `{branch}-wt-{random4digit}` (e.g. `main-wt-8374`).
 * Uses random suffixes to avoid collisions with leftover branches.
 */
export function generateUniqueWorktreeBranch(repoRoot: string, baseBranch: string, options?: { env?: Record<string, string> }): string {
  const env = options?.env;
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    const candidate = `${baseBranch}-wt-${suffix}`;
    if (gitSafe(`rev-parse --verify refs/heads/${candidate}`, repoRoot, env) === null) {
      return candidate;
    }
  }
  // Fallback: use timestamp if all random attempts collide (extremely unlikely)
  return `${baseBranch}-wt-${Date.now()}`;
}

export function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  options?: { force?: boolean; branchToDelete?: string; env?: Record<string, string> },
): { removed: boolean; reason?: string } {
  const env = options?.env;
  if (!existsSync(worktreePath)) {
    // Already gone, clean up git's reference
    gitSafe("worktree prune", repoRoot, env);
    if (options?.branchToDelete) {
      gitSafe(`branch -D ${options.branchToDelete}`, repoRoot, env);
    }
    return { removed: true };
  }

  if (!options?.force && isWorktreeDirty(worktreePath, { env })) {
    return {
      removed: false,
      reason: "Worktree has uncommitted changes. Use force to remove anyway.",
    };
  }

  try {
    const forceFlag = options?.force ? " --force" : "";
    git(`worktree remove "${worktreePath}"${forceFlag}`, repoRoot, env);
    // Clean up the companion-managed branch after worktree removal
    if (options?.branchToDelete) {
      gitSafe(`branch -D ${options.branchToDelete}`, repoRoot, env);
    }
    return { removed: true };
  } catch (e: unknown) {
    return {
      removed: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export function isWorktreeDirty(worktreePath: string, options?: { env?: Record<string, string> }): boolean {
  if (!existsSync(worktreePath)) return false;
  const status = gitSafe("status --porcelain", worktreePath, options?.env);
  return status !== null && status.length > 0;
}

export function gitFetch(cwd: string, options?: { env?: Record<string, string> }): { success: boolean; output: string } {
  try {
    const output = git("fetch --prune", cwd, options?.env);
    return { success: true, output };
  } catch (e: unknown) {
    return { success: false, output: e instanceof Error ? e.message : String(e) };
  }
}

export function gitPull(
  cwd: string,
  options?: { env?: Record<string, string> },
): { success: boolean; output: string } {
  try {
    const output = git("pull", cwd, options?.env);
    return { success: true, output };
  } catch (e: unknown) {
    return { success: false, output: e instanceof Error ? e.message : String(e) };
  }
}


export function checkoutBranch(cwd: string, branchName: string, options?: { env?: Record<string, string> }): void {
  git(`checkout ${branchName}`, cwd, options?.env);
}

export function getBranchStatus(
  repoRoot: string,
  branchName: string,
  options?: { env?: Record<string, string> },
): { ahead: number; behind: number } {
  const raw = gitSafe(
    `rev-list --left-right --count origin/${branchName}...${branchName}`,
    repoRoot,
    options?.env,
  );
  if (!raw) return { ahead: 0, behind: 0 };
  const [behind, ahead] = raw.split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}
