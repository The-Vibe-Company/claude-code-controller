import { Hono } from "hono";
import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";

export function createRoutes(launcher: CliLauncher, wsBridge: WsBridge) {
  const api = new Hono();

  // ─── SDK Sessions (--sdk-url) ─────────────────────────────────────

  api.post("/sessions/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const session = launcher.launch({
        model: body.model,
        permissionMode: body.permissionMode,
        cwd: body.cwd,
        claudeBinary: body.claudeBinary,
        allowedTools: body.allowedTools,
        env: body.env,
      });
      return c.json(session);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[routes] Failed to create session:", msg);
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/sessions", (c) => {
    return c.json(launcher.listSessions());
  });

  api.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
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
    launcher.removeSession(id);
    wsBridge.closeSession(id);
    return c.json({ ok: true });
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

  return api;
}
