import { Hono } from "hono";
import { execSync } from "node:child_process";
import { resolveBinary } from "./path-resolver.js";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SessionStore } from "./session-store.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import type { TerminalManager } from "./terminal-manager.js";
import * as envManager from "./env-manager.js";
import * as cronStore from "./cron-store.js";
import * as gitUtils from "./git-utils.js";
import * as sessionNames from "./session-names.js";
import { containerManager, type ContainerConfig, type ContainerInfo } from "./container-manager.js";
import { DEFAULT_OPENROUTER_MODEL, getSettings, updateSettings } from "./settings-manager.js";
import { getUsageLimits } from "./usage-limits.js";
import {
  getUpdateState,
  checkForUpdate,
  isUpdateAvailable,
  setUpdateInProgress,
} from "./update-checker.js";
import { refreshServiceDefinition } from "./service.js";
import type { AssistantManager } from "./assistant-manager.js";

const UPDATE_CHECK_STALE_MS = 5 * 60 * 1000;

function execCaptureStdout(
  command: string,
  options: { cwd: string; encoding: "utf-8"; timeout: number },
): string {
  try {
    return execSync(command, options);
  } catch (err: unknown) {
    const maybe = err as { stdout?: Buffer | string };
    if (typeof maybe.stdout === "string") return maybe.stdout;
    if (maybe.stdout && Buffer.isBuffer(maybe.stdout)) {
      return maybe.stdout.toString("utf-8");
    }
    throw err;
  }
}

function resolveBranchDiffBases(
  repoRoot: string,
): string[] {
  const options = { cwd: repoRoot, encoding: "utf-8", timeout: 5000 } as const;

  try {
    const originHead = execSync("git symbolic-ref refs/remotes/origin/HEAD", options).trim();
    const match = originHead.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) {
      return [`origin/${match[1]}`, match[1]];
    }
  } catch {
    // No remote HEAD ref available, fallback to common local defaults.
  }

  try {
    const branches = execSync("git branch --list main master", options).trim();
    if (branches.includes("main")) return ["main"];
    if (branches.includes("master")) return ["master"];
  } catch {
    // Ignore and use a conservative fallback below.
  }

  return ["main"];
}

export function createRoutes(
  launcher: CliLauncher,
  wsBridge: WsBridge,
  sessionStore: SessionStore,
  worktreeTracker: WorktreeTracker,
  terminalManager: TerminalManager,
  prPoller?: import("./pr-poller.js").PRPoller,
  recorder?: import("./recorder.js").RecorderManager,
  cronScheduler?: import("./cron-scheduler.js").CronScheduler,
  assistantManager?: AssistantManager,
) {
  const api = new Hono();

  // ─── SDK Sessions (--sdk-url) ─────────────────────────────────────

  api.post("/sessions/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const backend = body.backend ?? "claude";
      if (backend !== "claude" && backend !== "codex") {
        return c.json({ error: `Invalid backend: ${String(backend)}` }, 400);
      }

      // Resolve environment variables from envSlug
      let envVars: Record<string, string> | undefined = body.env;
      if (body.envSlug) {
        const companionEnv = envManager.getEnv(body.envSlug);
        if (companionEnv) {
          console.log(
            `[routes] Injecting env "${companionEnv.name}" (${Object.keys(companionEnv.variables).length} vars):`,
            Object.keys(companionEnv.variables).join(", "),
          );
          envVars = { ...companionEnv.variables, ...body.env };
        } else {
          console.warn(
            `[routes] Environment "${body.envSlug}" not found, ignoring`,
          );
        }
      }

      let cwd = body.cwd;
      let worktreeInfo:
        | {
            isWorktree: boolean;
            repoRoot: string;
            branch: string;
            actualBranch: string;
            worktreePath: string;
          }
        | undefined;

      // If worktree is requested, set up a worktree for the selected branch
      if (body.useWorktree && body.branch && cwd) {
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (repoInfo) {
          const result = gitUtils.ensureWorktree(
            repoInfo.repoRoot,
            body.branch,
            {
              baseBranch: repoInfo.defaultBranch,
              createBranch: body.createBranch,
              forceNew: true,
            },
          );
          cwd = result.worktreePath;
          worktreeInfo = {
            isWorktree: true,
            repoRoot: repoInfo.repoRoot,
            branch: body.branch,
            actualBranch: result.actualBranch,
            worktreePath: result.worktreePath,
          };
        }
      } else if (body.branch && cwd) {
        // Non-worktree: checkout the selected branch in-place
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (repoInfo) {
          const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
          if (!fetchResult.success) {
            throw new Error(`git fetch failed before session create: ${fetchResult.output}`);
          }

          if (repoInfo.currentBranch !== body.branch) {
            gitUtils.checkoutBranch(repoInfo.repoRoot, body.branch);
          }

          const pullResult = gitUtils.gitPull(repoInfo.repoRoot);
          if (!pullResult.success) {
            // Don't fail session creation if pull fails (e.g. no upstream tracking)
            console.warn(`[routes] git pull warning (non-fatal): ${pullResult.output}`);
          }
        }
      }

      // If container mode requested, create and start the container
      let containerInfo: ContainerInfo | undefined;
      if (body.container && backend === "claude") {
        const cConfig: ContainerConfig = {
          image: body.container.image || "companion-dev:latest",
          ports: Array.isArray(body.container.ports)
            ? body.container.ports.map(Number).filter((n: number) => n > 0)
            : [],
          volumes: body.container.volumes,
          env: body.container.env,
        };
        // Use cwd-based name since we don't have sessionId yet
        const containerId = crypto.randomUUID().slice(0, 8);
        containerInfo = containerManager.createContainer(containerId, cwd, cConfig);
      }

      const session = launcher.launch({
        model: body.model,
        permissionMode: body.permissionMode,
        cwd,
        claudeBinary: body.claudeBinary,
        codexBinary: body.codexBinary,
        codexInternetAccess: backend === "codex" && body.codexInternetAccess === true,
        codexSandbox: backend === "codex" && body.codexInternetAccess === true
          ? "danger-full-access"
          : "workspace-write",
        allowedTools: body.allowedTools,
        env: envVars,
        backendType: backend,
        worktreeInfo,
      });

      // Re-track container with real session ID
      if (containerInfo) {
        // The container was created with a temp ID; re-register under the real session ID
        containerManager.retrack(containerInfo.containerId, session.sessionId);
      }

      // Track the worktree mapping
      if (worktreeInfo) {
        worktreeTracker.addMapping({
          sessionId: session.sessionId,
          repoRoot: worktreeInfo.repoRoot,
          branch: worktreeInfo.branch,
          actualBranch: worktreeInfo.actualBranch,
          worktreePath: worktreeInfo.worktreePath,
          createdAt: Date.now(),
        });
      }

      return c.json(session);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[routes] Failed to create session:", msg);
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/sessions", (c) => {
    const sessions = launcher.listSessions();
    const names = sessionNames.getAllNames();
    const bridgeStates = wsBridge.getAllSessions();
    const bridgeMap = new Map(bridgeStates.map((s) => [s.session_id, s]));
    const enriched = sessions.map((s) => {
      const bridge = bridgeMap.get(s.sessionId);
      return {
        ...s,
        name: names[s.sessionId] ?? s.name,
        gitBranch: bridge?.git_branch || "",
        gitAhead: bridge?.git_ahead || 0,
        gitBehind: bridge?.git_behind || 0,
        totalLinesAdded: bridge?.total_lines_added || 0,
        totalLinesRemoved: bridge?.total_lines_removed || 0,
      };
    });
    return c.json(enriched);
  });

  api.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  api.patch("/sessions/:id/name", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    sessionNames.setName(id, body.name.trim());
    return c.json({ ok: true, name: body.name.trim() });
  });

  api.post("/sessions/:id/kill", async (c) => {
    const id = c.req.param("id");
    const killed = await launcher.kill(id);
    if (!killed)
      return c.json({ error: "Session not found or already exited" }, 404);

    // Clean up container if any
    containerManager.removeContainer(id);

    return c.json({ ok: true });
  });

  api.post("/sessions/:id/relaunch", async (c) => {
    const id = c.req.param("id");
    const ok = await launcher.relaunch(id);
    if (!ok) return c.json({ error: "Session not found" }, 404);
    return c.json({ ok: true });
  });

  api.delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (assistantManager?.isAssistantSession(id)) {
      return c.json({ error: "Cannot delete the assistant session. Use companion assistant stop instead." }, 403);
    }
    await launcher.kill(id);

    // Clean up container if any
    containerManager.removeContainer(id);

    // Clean up worktree if no other sessions use it (force: delete is destructive)
    const worktreeResult = cleanupWorktree(id, true);

    prPoller?.unwatch(id);
    launcher.removeSession(id);
    wsBridge.closeSession(id);
    return c.json({ ok: true, worktree: worktreeResult });
  });

  api.post("/sessions/:id/archive", async (c) => {
    const id = c.req.param("id");
    if (assistantManager?.isAssistantSession(id)) {
      return c.json({ error: "Cannot archive the assistant session. Use companion assistant stop instead." }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    await launcher.kill(id);

    // Clean up container if any
    containerManager.removeContainer(id);

    // Stop PR polling for this session
    prPoller?.unwatch(id);

    // Clean up worktree if no other sessions use it
    const worktreeResult = cleanupWorktree(id, body.force);

    launcher.setArchived(id, true);
    sessionStore.setArchived(id, true);
    return c.json({ ok: true, worktree: worktreeResult });
  });

  api.post("/sessions/:id/unarchive", (c) => {
    const id = c.req.param("id");
    launcher.setArchived(id, false);
    sessionStore.setArchived(id, false);
    return c.json({ ok: true });
  });

  // ─── Recording Management ──────────────────────────────────

  api.post("/sessions/:id/recording/start", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.enableForSession(id);
    return c.json({ ok: true, recording: true });
  });

  api.post("/sessions/:id/recording/stop", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.disableForSession(id);
    return c.json({ ok: true, recording: false });
  });

  api.get("/sessions/:id/recording/status", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ recording: false, available: false });
    return c.json({
      recording: recorder.isRecording(id),
      available: true,
      ...recorder.getRecordingStatus(id),
    });
  });

  api.get("/recordings", (c) => {
    if (!recorder) return c.json({ recordings: [] });
    return c.json({ recordings: recorder.listRecordings() });
  });

  // ─── Available backends ─────────────────────────────────────

  api.get("/backends", (c) => {
    const backends: Array<{ id: string; name: string; available: boolean }> = [];

    backends.push({ id: "claude", name: "Claude Code", available: resolveBinary("claude") !== null });
    backends.push({ id: "codex", name: "Codex", available: resolveBinary("codex") !== null });

    return c.json(backends);
  });

  api.get("/backends/:id/models", (c) => {
    const backendId = c.req.param("id");

    if (backendId === "codex") {
      // Read Codex model list from its local cache file
      const cachePath = join(homedir(), ".codex", "models_cache.json");
      if (!existsSync(cachePath)) {
        return c.json({ error: "Codex models cache not found. Run codex once to populate it." }, 404);
      }
      try {
        const raw = readFileSync(cachePath, "utf-8");
        const cache = JSON.parse(raw) as {
          models: Array<{
            slug: string;
            display_name?: string;
            description?: string;
            visibility?: string;
            priority?: number;
          }>;
        };
        // Only return visible models, sorted by priority
        const models = cache.models
          .filter((m) => m.visibility === "list")
          .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
          .map((m) => ({
            value: m.slug,
            label: m.display_name || m.slug,
            description: m.description || "",
          }));
        return c.json(models);
      } catch (e) {
        return c.json({ error: "Failed to parse Codex models cache" }, 500);
      }
    }

    // Claude models are hardcoded on the frontend
    return c.json({ error: "Use frontend defaults for this backend" }, 404);
  });

  // ─── Containers ─────────────────────────────────────────────────

  api.get("/containers/status", (c) => {
    const available = containerManager.checkDocker();
    const version = containerManager.getDockerVersion();
    return c.json({ available, version });
  });

  api.get("/containers/images", (c) => {
    const images = containerManager.listImages();
    return c.json(images);
  });

  // ─── Filesystem browsing ─────────────────────────────────────

  api.get("/fs/list", async (c) => {
    const rawPath = c.req.query("path") || homedir();
    const basePath = resolve(rawPath);
    try {
      const entries = await readdir(basePath, { withFileTypes: true });
      const dirs: { name: string; path: string }[] = [];
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          dirs.push({ name: entry.name, path: join(basePath, entry.name) });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      return c.json({ path: basePath, dirs, home: homedir() });
    } catch {
      return c.json(
        {
          error: "Cannot read directory",
          path: basePath,
          dirs: [],
          home: homedir(),
        },
        400,
      );
    }
  });

  api.get("/fs/home", (c) => {
    const home = homedir();
    const cwd = process.cwd();
    // Only report cwd if the user launched companion from a real project directory
    // (not from the package root or the home directory itself)
    const packageRoot = process.env.__COMPANION_PACKAGE_ROOT;
    const isProjectDir =
      cwd !== home &&
      (!packageRoot || !cwd.startsWith(packageRoot));
    return c.json({ home, cwd: isProjectDir ? cwd : home });
  });

  // ─── Editor filesystem APIs ─────────────────────────────────────

  /** Recursive directory tree for the editor file explorer */
  api.get("/fs/tree", async (c) => {
    const rawPath = c.req.query("path");
    if (!rawPath) return c.json({ error: "path required" }, 400);
    const basePath = resolve(rawPath);

    interface TreeNode {
      name: string;
      path: string;
      type: "file" | "directory";
      children?: TreeNode[];
    }

    async function buildTree(dir: string, depth: number): Promise<TreeNode[]> {
      if (depth > 10) return []; // Safety limit
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const nodes: TreeNode[] = [];
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules")
            continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            const children = await buildTree(fullPath, depth + 1);
            nodes.push({
              name: entry.name,
              path: fullPath,
              type: "directory",
              children,
            });
          } else if (entry.isFile()) {
            nodes.push({ name: entry.name, path: fullPath, type: "file" });
          }
        }
        nodes.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return nodes;
      } catch {
        return [];
      }
    }

    const tree = await buildTree(basePath, 0);
    return c.json({ path: basePath, tree });
  });

  /** Read a single file */
  api.get("/fs/read", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const absPath = resolve(filePath);
    try {
      const info = await stat(absPath);
      if (info.size > 2 * 1024 * 1024) {
        return c.json({ error: "File too large (>2MB)" }, 413);
      }
      const content = await readFile(absPath, "utf-8");
      return c.json({ path: absPath, content });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot read file" },
        404,
      );
    }
  });

  /** Write a single file */
  api.put("/fs/write", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { path: filePath, content } = body;
    if (!filePath || typeof content !== "string") {
      return c.json({ error: "path and content required" }, 400);
    }
    const absPath = resolve(filePath);
    try {
      await writeFile(absPath, content, "utf-8");
      return c.json({ ok: true, path: absPath });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot write file" },
        500,
      );
    }
  });

  /** Git diff for a single file (unified diff) */
  api.get("/fs/diff", (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const absPath = resolve(filePath);
    try {
      const repoRoot = execSync("git rev-parse --show-toplevel", {
        cwd: dirname(absPath),
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const relPath = execSync(`git -C "${repoRoot}" ls-files --full-name -- "${absPath}"`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim() || absPath;

      let diff = "";
      const diffBases = resolveBranchDiffBases(repoRoot);
      for (const base of diffBases) {
        try {
          diff = execCaptureStdout(`git diff ${base} -- "${relPath}"`, {
            cwd: repoRoot,
            encoding: "utf-8",
            timeout: 5000,
          });
          break;
        } catch {
          // If a base ref is unavailable, try the next candidate.
        }
      }

      // For untracked files, base-branch diff is empty. Show full file as added.
      if (!diff.trim()) {
        const untracked = execSync(`git ls-files --others --exclude-standard -- "${relPath}"`, {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        if (untracked) {
          diff = execCaptureStdout(`git diff --no-index -- /dev/null "${absPath}"`, {
            cwd: repoRoot,
            encoding: "utf-8",
            timeout: 5000,
          });
        }
      }

      return c.json({ path: absPath, diff });
    } catch {
      return c.json({ path: absPath, diff: "" });
    }
  });

  /** Find CLAUDE.md files for a project (root + .claude/) */
  api.get("/fs/claude-md", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd required" }, 400);

    // Resolve to absolute path to prevent path traversal
    const resolvedCwd = resolve(cwd);

    const candidates = [
      join(resolvedCwd, "CLAUDE.md"),
      join(resolvedCwd, ".claude", "CLAUDE.md"),
    ];

    const files: { path: string; content: string }[] = [];
    for (const p of candidates) {
      try {
        const content = await readFile(p, "utf-8");
        files.push({ path: p, content });
      } catch {
        // file doesn't exist — skip
      }
    }

    return c.json({ cwd: resolvedCwd, files });
  });

  /** Create or update a CLAUDE.md file */
  api.put("/fs/claude-md", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { path: filePath, content } = body;
    if (!filePath || typeof content !== "string") {
      return c.json({ error: "path and content required" }, 400);
    }
    // Only allow writing CLAUDE.md files
    const base = filePath.split("/").pop();
    if (base !== "CLAUDE.md") {
      return c.json({ error: "Can only write CLAUDE.md files" }, 400);
    }
    const absPath = resolve(filePath);
    // Verify the resolved path ends with CLAUDE.md or .claude/CLAUDE.md
    if (!absPath.endsWith("/CLAUDE.md") && !absPath.endsWith("/.claude/CLAUDE.md")) {
      return c.json({ error: "Invalid CLAUDE.md path" }, 400);
    }
    try {
      // Ensure parent directory exists
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, "utf-8");
      return c.json({ ok: true, path: absPath });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot write file" },
        500,
      );
    }
  });

  // ─── Environments (~/.companion/envs/) ────────────────────────────

  api.get("/envs", (c) => {
    try {
      return c.json(envManager.listEnvs());
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/envs/:slug", (c) => {
    const env = envManager.getEnv(c.req.param("slug"));
    if (!env) return c.json({ error: "Environment not found" }, 404);
    return c.json(env);
  });

  api.post("/envs", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const env = envManager.createEnv(body.name, body.variables || {});
      return c.json(env, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.put("/envs/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json().catch(() => ({}));
    try {
      const env = envManager.updateEnv(slug, {
        name: body.name,
        variables: body.variables,
      });
      if (!env) return c.json({ error: "Environment not found" }, 404);
      return c.json(env);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/envs/:slug", (c) => {
    const deleted = envManager.deleteEnv(c.req.param("slug"));
    if (!deleted) return c.json({ error: "Environment not found" }, 404);
    return c.json({ ok: true });
  });

  // ─── Settings (~/.companion/settings.json) ────────────────────────

  api.get("/settings", (c) => {
    const settings = getSettings();
    return c.json({
      openrouterApiKeyConfigured: !!settings.openrouterApiKey.trim(),
      openrouterModel: settings.openrouterModel || DEFAULT_OPENROUTER_MODEL,
    });
  });

  api.put("/settings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.openrouterApiKey !== undefined && typeof body.openrouterApiKey !== "string") {
      return c.json({ error: "openrouterApiKey must be a string" }, 400);
    }
    if (body.openrouterModel !== undefined && typeof body.openrouterModel !== "string") {
      return c.json({ error: "openrouterModel must be a string" }, 400);
    }
    if (body.openrouterApiKey === undefined && body.openrouterModel === undefined) {
      return c.json({ error: "At least one settings field is required" }, 400);
    }

    const settings = updateSettings({
      openrouterApiKey:
        typeof body.openrouterApiKey === "string"
          ? body.openrouterApiKey.trim()
          : undefined,
      openrouterModel:
        typeof body.openrouterModel === "string"
          ? (body.openrouterModel.trim() || DEFAULT_OPENROUTER_MODEL)
          : undefined,
    });

    return c.json({
      openrouterApiKeyConfigured: !!settings.openrouterApiKey.trim(),
      openrouterModel: settings.openrouterModel || DEFAULT_OPENROUTER_MODEL,
    });
  });

  // ─── Git operations ─────────────────────────────────────────────────

  api.get("/git/repo-info", (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path required" }, 400);
    const info = gitUtils.getRepoInfo(path);
    if (!info) return c.json({ error: "Not a git repository" }, 400);
    return c.json(info);
  });

  api.get("/git/branches", (c) => {
    const repoRoot = c.req.query("repoRoot");
    if (!repoRoot) return c.json({ error: "repoRoot required" }, 400);
    try {
      return c.json(gitUtils.listBranches(repoRoot));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/git/worktrees", (c) => {
    const repoRoot = c.req.query("repoRoot");
    if (!repoRoot) return c.json({ error: "repoRoot required" }, 400);
    try {
      return c.json(gitUtils.listWorktrees(repoRoot));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.post("/git/worktree", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot, branch, baseBranch, createBranch } = body;
    if (!repoRoot || !branch)
      return c.json({ error: "repoRoot and branch required" }, 400);
    try {
      const result = gitUtils.ensureWorktree(repoRoot, branch, {
        baseBranch,
        createBranch,
      });
      return c.json(result);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.delete("/git/worktree", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot, worktreePath, force } = body;
    if (!repoRoot || !worktreePath)
      return c.json({ error: "repoRoot and worktreePath required" }, 400);
    const result = gitUtils.removeWorktree(repoRoot, worktreePath, { force });
    return c.json(result);
  });

  api.post("/git/fetch", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot } = body;
    if (!repoRoot) return c.json({ error: "repoRoot required" }, 400);
    return c.json(gitUtils.gitFetch(repoRoot));
  });

  api.post("/git/pull", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd } = body;
    if (!cwd) return c.json({ error: "cwd required" }, 400);
    const result = gitUtils.gitPull(cwd);
    // Return refreshed ahead/behind counts
    let git_ahead = 0,
      git_behind = 0;
    try {
      const counts = execSync(
        "git rev-list --left-right --count @{upstream}...HEAD",
        {
          cwd,
          encoding: "utf-8",
          timeout: 3000,
        },
      ).trim();
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      git_ahead = ahead || 0;
      git_behind = behind || 0;
    } catch {
      /* no upstream */
    }
    return c.json({ ...result, git_ahead, git_behind });
  });

  // ─── GitHub PR Status ────────────────────────────────────────────────

  api.get("/git/pr-status", async (c) => {
    const cwd = c.req.query("cwd");
    const branch = c.req.query("branch");
    if (!cwd || !branch) return c.json({ error: "cwd and branch required" }, 400);

    // Check poller cache first for instant response
    if (prPoller) {
      const cached = prPoller.getCached(cwd, branch);
      if (cached) return c.json(cached);
    }

    const { isGhAvailable, fetchPRInfoAsync } = await import("./github-pr.js");
    if (!isGhAvailable()) {
      return c.json({ available: false, pr: null });
    }

    const pr = await fetchPRInfoAsync(cwd, branch);
    return c.json({ available: true, pr });
  });

  // ─── Usage Limits ─────────────────────────────────────────────────────

  api.get("/usage-limits", async (c) => {
    const limits = await getUsageLimits();
    return c.json(limits);
  });

  api.get("/sessions/:id/usage-limits", async (c) => {
    const sessionId = c.req.param("id");
    const session = wsBridge.getSession(sessionId);
    const empty = { five_hour: null, seven_day: null, extra_usage: null };

    if (session?.backendType === "codex") {
      const rl = wsBridge.getCodexRateLimits(sessionId);
      if (!rl) return c.json(empty);
      const mapLimit = (l: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null) => {
        if (!l) return null;
        return {
          utilization: l.usedPercent,
          resets_at: l.resetsAt ? new Date(l.resetsAt * 1000).toISOString() : null,
        };
      };
      return c.json({
        five_hour: mapLimit(rl.primary),
        seven_day: mapLimit(rl.secondary),
        extra_usage: null,
      });
    }

    // Claude sessions: use existing logic
    const limits = await getUsageLimits();
    return c.json(limits);
  });

  // ─── Update checking ─────────────────────────────────────────────────

  api.get("/update-check", async (c) => {
    const initialState = getUpdateState();
    const needsRefresh =
      initialState.lastChecked === 0
      || Date.now() - initialState.lastChecked > UPDATE_CHECK_STALE_MS;
    if (needsRefresh) {
      await checkForUpdate();
    }

    const state = getUpdateState();
    return c.json({
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      updateAvailable: isUpdateAvailable(),
      isServiceMode: state.isServiceMode,
      updateInProgress: state.updateInProgress,
      lastChecked: state.lastChecked,
    });
  });

  api.post("/update-check", async (c) => {
    await checkForUpdate();
    const state = getUpdateState();
    return c.json({
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      updateAvailable: isUpdateAvailable(),
      isServiceMode: state.isServiceMode,
      updateInProgress: state.updateInProgress,
      lastChecked: state.lastChecked,
    });
  });

  api.post("/update", async (c) => {
    const state = getUpdateState();
    if (!state.isServiceMode) {
      return c.json(
        { error: "Update & restart is only available in service mode" },
        400,
      );
    }
    if (!isUpdateAvailable()) {
      return c.json({ error: "No update available" }, 400);
    }
    if (state.updateInProgress) {
      return c.json({ error: "Update already in progress" }, 409);
    }

    setUpdateInProgress(true);

    // Respond immediately, then perform update async
    setTimeout(async () => {
      try {
        console.log(
          `[update] Updating the-companion to ${state.latestVersion}...`,
        );
        const proc = Bun.spawn(
          ["bun", "install", "-g", `the-companion@${state.latestVersion}`],
          { stdout: "pipe", stderr: "pipe" },
        );
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          console.error(
            `[update] bun install failed (code ${exitCode}):`,
            stderr,
          );
          setUpdateInProgress(false);
          return;
        }

        // Refresh the service definition so the new unit/plist template
        // (e.g. Restart=always) takes effect for existing installations.
        try {
          refreshServiceDefinition();
          console.log("[update] Service definition refreshed.");
        } catch (err) {
          console.warn("[update] Failed to refresh service definition:", err);
        }

        console.log(
          "[update] Update successful, restarting service...",
        );

        // Explicitly restart via the service manager in a detached process
        // so the restart survives our own exit.
        const isLinux = process.platform === "linux";
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
        const restartCmd = isLinux
          ? ["systemctl", "--user", "restart", "the-companion.service"]
          : uid !== undefined
            ? ["launchctl", "kickstart", "-k", `gui/${uid}/sh.thecompanion.app`]
            : ["launchctl", "kickstart", "-k", "sh.thecompanion.app"];

        Bun.spawn(restartCmd, {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
          env: isLinux
            ? {
                ...process.env,
                XDG_RUNTIME_DIR:
                  process.env.XDG_RUNTIME_DIR ||
                  `/run/user/${uid ?? 1000}`,
              }
            : undefined,
        });

        // Give the spawn a moment to dispatch, then exit cleanly.
        // The service manager restart will kill us if we haven't exited yet.
        setTimeout(() => process.exit(0), 500);
      } catch (err) {
        console.error("[update] Update failed:", err);
        setUpdateInProgress(false);
      }
    }, 100);

    return c.json({
      ok: true,
      message: "Update started. Server will restart shortly.",
    });
  });

  // ─── Helper ─────────────────────────────────────────────────────────

  function cleanupWorktree(
    sessionId: string,
    force?: boolean,
  ): { cleaned?: boolean; dirty?: boolean; path?: string } | undefined {
    const mapping = worktreeTracker.getBySession(sessionId);
    if (!mapping) return undefined;

    // Check if any other sessions still use this worktree
    if (worktreeTracker.isWorktreeInUse(mapping.worktreePath, sessionId)) {
      worktreeTracker.removeBySession(sessionId);
      return { cleaned: false, path: mapping.worktreePath };
    }

    // Auto-remove if clean, or force-remove if requested
    const dirty = gitUtils.isWorktreeDirty(mapping.worktreePath);
    if (dirty && !force) {
      console.log(
        `[routes] Worktree ${mapping.worktreePath} is dirty, not auto-removing`,
      );
      // Keep the mapping so the worktree remains trackable
      return { cleaned: false, dirty: true, path: mapping.worktreePath };
    }

    // Delete the companion-managed branch if it differs from the conceptual branch
    const branchToDelete =
      mapping.actualBranch && mapping.actualBranch !== mapping.branch
        ? mapping.actualBranch
        : undefined;
    const result = gitUtils.removeWorktree(
      mapping.repoRoot,
      mapping.worktreePath,
      { force: dirty, branchToDelete },
    );
    if (result.removed) {
      // Only remove the mapping after successful cleanup
      worktreeTracker.removeBySession(sessionId);
      console.log(
        `[routes] ${dirty ? "Force-removed dirty" : "Auto-removed clean"} worktree ${mapping.worktreePath}`,
      );
    }
    return { cleaned: result.removed, path: mapping.worktreePath };
  }

  // ─── Terminal ──────────────────────────────────────────────────────

  api.get("/terminal", (c) => {
    const info = terminalManager.getInfo();
    if (!info) return c.json({ active: false });
    return c.json({ active: true, terminalId: info.id, cwd: info.cwd });
  });

  api.post("/terminal/spawn", async (c) => {
    const body = await c.req.json<{ cwd: string; cols?: number; rows?: number }>();
    if (!body.cwd) return c.json({ error: "cwd is required" }, 400);
    const terminalId = terminalManager.spawn(body.cwd, body.cols, body.rows);
    return c.json({ terminalId });
  });

  api.post("/terminal/kill", (c) => {
    terminalManager.kill();
    return c.json({ ok: true });
  });

  // ─── Cross-session messaging ───────────────────────────────────────

  api.post("/sessions/:id/message", async (c) => {
    const id = c.req.param("id");
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!launcher.isAlive(id)) return c.json({ error: "Session is not running" }, 400);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    wsBridge.injectUserMessage(id, body.content);
    return c.json({ ok: true, sessionId: id });
  });

  // ─── Companion Assistant ──────────────────────────────────────────

  api.get("/assistant/status", (c) => {
    if (!assistantManager) return c.json({ error: "Assistant not available" }, 501);
    return c.json(assistantManager.getStatus());
  });

  api.post("/assistant/launch", async (c) => {
    if (!assistantManager) return c.json({ error: "Assistant not available" }, 501);
    const session = await assistantManager.start();
    if (!session) return c.json({ error: "Failed to launch assistant" }, 500);
    return c.json({ ok: true, sessionId: session.sessionId });
  });

  api.post("/assistant/stop", async (c) => {
    if (!assistantManager) return c.json({ error: "Assistant not available" }, 501);
    const stopped = await assistantManager.stop();
    return c.json({ ok: stopped });
  });

  api.get("/assistant/config", (c) => {
    if (!assistantManager) return c.json({ error: "Assistant not available" }, 501);
    return c.json(assistantManager.getConfig());
  });

  api.put("/assistant/config", async (c) => {
    if (!assistantManager) return c.json({ error: "Assistant not available" }, 501);
    const body = await c.req.json().catch(() => ({}));
    const config = assistantManager.updateConfig({
      model: typeof body.model === "string" ? body.model : undefined,
      permissionMode: typeof body.permissionMode === "string" ? body.permissionMode : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    });
    return c.json(config);
  });

  // ─── Skills ─────────────────────────────────────────────────────────

  const SKILLS_DIR = join(homedir(), ".claude", "skills");

  api.get("/skills", async (c) => {
    try {
      if (!existsSync(SKILLS_DIR)) return c.json([]);
      const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
      const skills = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = join(SKILLS_DIR, entry.name, "SKILL.md");
        if (!existsSync(skillMdPath)) continue;
        const content = await readFile(skillMdPath, "utf-8");
        // Parse frontmatter
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        let name = entry.name;
        let description = "";
        let body = content;
        if (fmMatch) {
          body = fmMatch[2];
          for (const line of fmMatch[1].split("\n")) {
            const nameMatch = line.match(/^name:\s*(.+)/);
            if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
            const descMatch = line.match(/^description:\s*["']?(.+?)["']?\s*$/);
            if (descMatch) description = descMatch[1];
          }
        }
        skills.push({ slug: entry.name, name, description, path: skillMdPath });
      }
      return c.json(skills);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  api.get("/skills/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    const skillMdPath = join(SKILLS_DIR, slug, "SKILL.md");
    if (!existsSync(skillMdPath)) return c.json({ error: "Skill not found" }, 404);
    const content = await readFile(skillMdPath, "utf-8");
    return c.json({ slug, path: skillMdPath, content });
  });

  api.post("/skills", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { name, description, content } = body;
    if (!name || typeof name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }
    // Slugify: lowercase, replace non-alphanumeric with dashes
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) return c.json({ error: "Invalid name" }, 400);

    const skillDir = join(SKILLS_DIR, slug);
    const skillMdPath = join(skillDir, "SKILL.md");

    if (existsSync(skillMdPath)) {
      return c.json({ error: `Skill "${slug}" already exists` }, 409);
    }

    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(skillDir, { recursive: true });

    const md = `---\nname: ${slug}\ndescription: ${JSON.stringify(description || `Skill: ${name}`)}\n---\n\n${content || `# ${name}\n\nDescribe what this skill does and how to use it.\n`}`;
    writeFileSync(skillMdPath, md);

    return c.json({ slug, name, description: description || `Skill: ${name}`, path: skillMdPath });
  });

  api.put("/skills/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    const skillMdPath = join(SKILLS_DIR, slug, "SKILL.md");
    if (!existsSync(skillMdPath)) return c.json({ error: "Skill not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string") {
      return c.json({ error: "content is required" }, 400);
    }
    await writeFile(skillMdPath, body.content);
    return c.json({ ok: true, slug, path: skillMdPath });
  });

  api.delete("/skills/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    const skillDir = join(SKILLS_DIR, slug);
    if (!existsSync(skillDir)) return c.json({ error: "Skill not found" }, 404);
    const { rmSync } = await import("node:fs");
    rmSync(skillDir, { recursive: true });
    return c.json({ ok: true, slug });
  });

  // ─── Cron Jobs ──────────────────────────────────────────────────────

  api.get("/cron/jobs", (c) => {
    const jobs = cronStore.listJobs();
    const enriched = jobs.map((j) => ({
      ...j,
      nextRunAt: cronScheduler?.getNextRunTime(j.id)?.getTime() ?? null,
    }));
    return c.json(enriched);
  });

  api.get("/cron/jobs/:id", (c) => {
    const job = cronStore.getJob(c.req.param("id"));
    if (!job) return c.json({ error: "Job not found" }, 404);
    return c.json({
      ...job,
      nextRunAt: cronScheduler?.getNextRunTime(job.id)?.getTime() ?? null,
    });
  });

  api.post("/cron/jobs", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const job = cronStore.createJob({
        name: body.name || "",
        prompt: body.prompt || "",
        schedule: body.schedule || "",
        recurring: body.recurring ?? true,
        backendType: body.backendType || "claude",
        model: body.model || "",
        cwd: body.cwd || "",
        envSlug: body.envSlug,
        enabled: body.enabled ?? true,
        permissionMode: body.permissionMode || "bypassPermissions",
        codexInternetAccess: body.codexInternetAccess,
      });
      if (job.enabled) cronScheduler?.scheduleJob(job);
      return c.json(job, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.put("/cron/jobs/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    try {
      // Only allow user-editable fields — prevent tampering with internal tracking
      const allowed: Record<string, unknown> = {};
      for (const key of ["name", "prompt", "schedule", "recurring", "backendType", "model", "cwd", "envSlug", "enabled", "permissionMode", "codexInternetAccess"] as const) {
        if (key in body) allowed[key] = body[key];
      }
      const job = cronStore.updateJob(id, allowed);
      if (!job) return c.json({ error: "Job not found" }, 404);
      // Stop the old timer (id may differ from job.id after a rename)
      if (job.id !== id) cronScheduler?.stopJob(id);
      cronScheduler?.scheduleJob(job);
      return c.json(job);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/cron/jobs/:id", (c) => {
    const id = c.req.param("id");
    cronScheduler?.stopJob(id);
    const deleted = cronStore.deleteJob(id);
    if (!deleted) return c.json({ error: "Job not found" }, 404);
    return c.json({ ok: true });
  });

  api.post("/cron/jobs/:id/toggle", (c) => {
    const id = c.req.param("id");
    const job = cronStore.getJob(id);
    if (!job) return c.json({ error: "Job not found" }, 404);
    const updated = cronStore.updateJob(id, { enabled: !job.enabled });
    if (updated?.enabled) {
      cronScheduler?.scheduleJob(updated);
    } else {
      cronScheduler?.stopJob(id);
    }
    return c.json(updated);
  });

  api.post("/cron/jobs/:id/run", (c) => {
    const id = c.req.param("id");
    const job = cronStore.getJob(id);
    if (!job) return c.json({ error: "Job not found" }, 404);
    cronScheduler?.executeJobManually(id);
    return c.json({ ok: true, message: "Job triggered" });
  });

  api.get("/cron/jobs/:id/executions", (c) => {
    const id = c.req.param("id");
    return c.json(cronScheduler?.getExecutions(id) ?? []);
  });

  // ─── Memory System ──────────────────────────────────────────────────

  api.get("/memory/status", async (c) => {
    try {
      const { getMemoryManager } = await import("./memory-manager.js");
      const manager = getMemoryManager();
      const stats = manager.getStats();
      const config = manager.getConfig();
      return c.json({
        enabled: config.enabled,
        stats,
        config: {
          provider: config.search.provider,
          model: config.search.model,
          hybridEnabled: config.search.hybrid.enabled,
          cacheEnabled: config.search.cache.enabled,
        },
      });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Failed to get memory status" },
        500,
      );
    }
  });

  api.get("/memory/search", async (c) => {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "Query parameter 'q' required" }, 400);

    const limit = parseInt(c.req.query("limit") || "10", 10);
    const minScore = parseFloat(c.req.query("minScore") || "0");

    try {
      const { getMemoryManager } = await import("./memory-manager.js");
      const manager = getMemoryManager();
      const results = await manager.search({ query, limit, minScore });
      return c.json({ query, results });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Search failed" },
        500,
      );
    }
  });

  api.post("/memory/reindex", async (c) => {
    try {
      const { getMemoryManager } = await import("./memory-manager.js");
      const manager = getMemoryManager();

      // Run reindexing in background
      let progress = { current: 0, total: 0, file: "" };
      const promise = manager.reindex((current, total, file) => {
        progress = { current, total, file };
      });

      // Return immediately
      return c.json({
        ok: true,
        message: "Reindexing started in background",
      });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Reindex failed" },
        500,
      );
    }
  });

  api.get("/memory/config", async (c) => {
    try {
      const { getMemoryManager } = await import("./memory-manager.js");
      const manager = getMemoryManager();
      return c.json(manager.getConfig());
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Failed to get config" },
        500,
      );
    }
  });

  api.put("/memory/config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const { getMemoryManager } = await import("./memory-manager.js");
      const manager = getMemoryManager();

      const updates: Record<string, unknown> = {};
      if (body.enabled !== undefined) updates.enabled = body.enabled;
      if (body.provider) {
        updates.search = {
          ...manager.getConfig().search,
          provider: body.provider,
        };
      }
      if (body.model) {
        updates.search = {
          ...(updates.search || manager.getConfig().search),
          model: body.model,
        };
      }
      if (body.apiKey) {
        updates.search = {
          ...(updates.search || manager.getConfig().search),
          apiKey: body.apiKey,
        };
      }

      const updated = manager.updateConfig(updates);
      return c.json(updated);
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Failed to update config" },
        500,
      );
    }
  });

  api.get("/memory/export", async (c) => {
    const output = c.req.query("output");
    if (!output) return c.json({ error: "output path required" }, 400);

    try {
      const { getMemoryManager } = await import("./memory-manager.js");
      const manager = getMemoryManager();
      const files = manager.listFiles();

      const data = {
        version: "1.0",
        exportedAt: new Date().toISOString(),
        config: manager.getConfig(),
        files: files.map((f) => ({
          path: f.path,
          source: f.source,
          content: readFileSync(f.absolutePath, "utf-8"),
        })),
      };

      await writeFile(output, JSON.stringify(data, null, 2), "utf-8");
      return c.json({ ok: true, output, fileCount: files.length });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Export failed" },
        500,
      );
    }
  });

  api.post("/memory/import", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const inputPath = body.input;
    if (!inputPath) return c.json({ error: "input path required" }, 400);

    try {
      const data = JSON.parse(await readFile(inputPath, "utf-8"));
      const { getMemoryManager } = await import("./memory-manager.js");
      const manager = getMemoryManager();

      // Import files
      let imported = 0;
      for (const file of data.files || []) {
        const fullPath = join(manager.getMemoryDir(), file.path);
        await writeFile(fullPath, file.content, "utf-8");
        await manager.indexFile(file.source, file.path, file.content);
        imported++;
      }

      return c.json({ ok: true, imported });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Import failed" },
        500,
      );
    }
  });

  return api;
}
