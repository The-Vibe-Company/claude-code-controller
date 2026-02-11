import { Hono } from "hono";
import { execSync } from "node:child_process";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SessionStore } from "./session-store.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import * as envManager from "./env-manager.js";
import * as gitUtils from "./git-utils.js";
import * as sessionNames from "./session-names.js";
import { authMiddleware, authStatusHandler, isAuthEnabled } from "./auth.js";

export function createRoutes(launcher: CliLauncher, wsBridge: WsBridge, sessionStore: SessionStore, worktreeTracker: WorktreeTracker) {
  const api = new Hono();

  // ─── Auth (public route first, then middleware) ─────────────────────
  api.get("/auth/status", authStatusHandler);
  api.use("/*", authMiddleware());

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
          console.log(`[routes] Injecting env "${companionEnv.name}" (${Object.keys(companionEnv.variables).length} vars):`, Object.keys(companionEnv.variables).join(", "));
          envVars = { ...companionEnv.variables, ...body.env };
        } else {
          console.warn(`[routes] Environment "${body.envSlug}" not found, ignoring`);
        }
      }

      let cwd = body.cwd;
      let worktreeInfo: { isWorktree: boolean; repoRoot: string; branch: string; actualBranch: string; worktreePath: string } | undefined;

      // If worktree is requested, set up a worktree for the selected branch
      if (body.useWorktree && body.branch && cwd) {
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (repoInfo) {
          const result = gitUtils.ensureWorktree(repoInfo.repoRoot, body.branch, {
            baseBranch: repoInfo.defaultBranch,
            createBranch: body.createBranch,
            forceNew: true,
          });
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
        if (repoInfo && repoInfo.currentBranch !== body.branch) {
          gitUtils.checkoutBranch(repoInfo.repoRoot, body.branch);
        }
      }

      const session = launcher.launch({
        model: body.model,
        permissionMode: body.permissionMode,
        cwd,
        claudeBinary: body.claudeBinary,
        codexBinary: body.codexBinary,
        allowedTools: body.allowedTools,
        env: envVars,
        backendType: backend,
        worktreeInfo,
      });

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
    const enriched = sessions.map((s) => ({
      ...s,
      name: names[s.sessionId] ?? s.name,
    }));
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
    if (!killed) return c.json({ error: "Session not found or already exited" }, 404);

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
    await launcher.kill(id);


    // Clean up worktree if no other sessions use it (force: delete is destructive)
    const worktreeResult = cleanupWorktree(id, true);

    launcher.removeSession(id);
    wsBridge.closeSession(id);
    return c.json({ ok: true, worktree: worktreeResult });
  });

  api.post("/sessions/:id/archive", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    await launcher.kill(id);


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

  // ─── Available backends ─────────────────────────────────────

  api.get("/backends", (c) => {
    const backends: Array<{ id: string; name: string; available: boolean }> = [];

    // Check Claude Code
    let claudeAvailable = false;
    try {
      execSync("which claude", { encoding: "utf-8", timeout: 3000 });
      claudeAvailable = true;
    } catch {}
    backends.push({ id: "claude", name: "Claude Code", available: claudeAvailable });

    // Check Codex
    let codexAvailable = false;
    try {
      execSync("which codex", { encoding: "utf-8", timeout: 3000 });
      codexAvailable = true;
    } catch {}
    backends.push({ id: "codex", name: "Codex", available: codexAvailable });

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
      return c.json({ error: "Cannot read directory", path: basePath, dirs: [], home: homedir() }, 400);
    }
  });

  api.get("/fs/home", (c) => {
    return c.json({ home: homedir(), cwd: process.cwd() });
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
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            const children = await buildTree(fullPath, depth + 1);
            nodes.push({ name: entry.name, path: fullPath, type: "directory", children });
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
      return c.json({ error: e instanceof Error ? e.message : "Cannot read file" }, 404);
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
      return c.json({ error: e instanceof Error ? e.message : "Cannot write file" }, 500);
    }
  });

  /** Git diff for a single file (unified diff) */
  api.get("/fs/diff", (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const absPath = resolve(filePath);
    try {
      const diff = execSync(`git diff HEAD -- "${absPath}"`, {
        cwd: dirname(absPath),
        encoding: "utf-8",
        timeout: 5000,
      });
      return c.json({ path: absPath, diff });
    } catch {
      return c.json({ path: absPath, diff: "" });
    }
  });

  // ─── Environments (~/.companion/envs/) ────────────────────────

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
      const env = envManager.updateEnv(slug, { name: body.name, variables: body.variables });
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
    if (!repoRoot || !branch) return c.json({ error: "repoRoot and branch required" }, 400);
    try {
      const result = gitUtils.ensureWorktree(repoRoot, branch, { baseBranch, createBranch });
      return c.json(result);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.delete("/git/worktree", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot, worktreePath, force } = body;
    if (!repoRoot || !worktreePath) return c.json({ error: "repoRoot and worktreePath required" }, 400);
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
    let git_ahead = 0, git_behind = 0;
    try {
      const counts = execSync("git rev-list --left-right --count @{upstream}...HEAD", {
        cwd, encoding: "utf-8", timeout: 3000,
      }).trim();
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      git_ahead = ahead || 0;
      git_behind = behind || 0;
    } catch { /* no upstream */ }
    return c.json({ ...result, git_ahead, git_behind });
  });


  // ─── Speech-to-Text (ElevenLabs proxy) ─────────────────────────────

  api.post("/stt/transcribe", async (c) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return c.json({ error: "ELEVENLABS_API_KEY not configured" }, 400);
    }

    const body = await c.req.parseBody();
    const audioFile = body.audio;
    if (!audioFile || !(audioFile instanceof File)) {
      return c.json({ error: "audio file is required" }, 400);
    }

    if (audioFile.size > 25 * 1024 * 1024) {
      return c.json({ error: "Audio file too large (max 25MB)" }, 413);
    }

    const languageCode = typeof body.language_code === "string" ? body.language_code : undefined;

    try {
      const form = new FormData();
      form.append("file", audioFile, audioFile.name || "audio.webm");
      form.append("model_id", "scribe_v2");
      if (languageCode) form.append("language_code", languageCode);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30_000);

      const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const errBody = await res.text().catch(() => res.statusText);
        console.error("[stt] ElevenLabs API error:", res.status, errBody);
        return c.json({ error: "Transcription failed", details: errBody }, res.status as 400);
      }

      const result = await res.json() as { text?: string; transcription?: string };
      return c.json({ text: result.text || result.transcription || "" });
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") {
        return c.json({ error: "Transcription request timed out" }, 504);
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[stt] Transcription error:", msg);
      return c.json({ error: msg }, 500);
    }
  });

  // ─── Helper ─────────────────────────────────────────────────────────

  function cleanupWorktree(sessionId: string, force?: boolean): { cleaned?: boolean; dirty?: boolean; path?: string } | undefined {
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
      console.log(`[routes] Worktree ${mapping.worktreePath} is dirty, not auto-removing`);
      // Keep the mapping so the worktree remains trackable
      return { cleaned: false, dirty: true, path: mapping.worktreePath };
    }

    // Delete the companion-managed branch if it differs from the conceptual branch
    const branchToDelete = mapping.actualBranch && mapping.actualBranch !== mapping.branch
      ? mapping.actualBranch
      : undefined;
    const result = gitUtils.removeWorktree(mapping.repoRoot, mapping.worktreePath, { force: dirty, branchToDelete });
    if (result.removed) {
      // Only remove the mapping after successful cleanup
      worktreeTracker.removeBySession(sessionId);
      console.log(`[routes] ${dirty ? "Force-removed dirty" : "Auto-removed clean"} worktree ${mapping.worktreePath}`);
    }
    return { cleaned: result.removed, path: mapping.worktreePath };
  }

  return api;
}
