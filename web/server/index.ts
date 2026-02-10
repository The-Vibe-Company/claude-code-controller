process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { createRoutes } from "./routes.js";
import { CliLauncher } from "./cli-launcher.js";
import { WsBridge } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import type { SocketData } from "./ws-bridge.js";
import type { ServerWebSocket } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.__VIBE_PACKAGE_ROOT || resolve(__dirname, "..");

const port = Number(process.env.PORT) || 3456;
const sessionStore = new SessionStore();
const wsBridge = new WsBridge();
const launcher = new CliLauncher(port);

// ── Restore persisted sessions from disk ────────────────────────────────────
wsBridge.setStore(sessionStore);
launcher.setStore(sessionStore);
launcher.restoreFromDisk();
wsBridge.restoreFromDisk();

// When the CLI reports its internal session_id, store it for --resume on relaunch
wsBridge.onCLISessionIdReceived((sessionId, cliSessionId) => {
  launcher.setCLISessionId(sessionId, cliSessionId);
});

// Auto-relaunch CLI when a browser connects to a session with no CLI
const relaunchingSet = new Set<string>();
wsBridge.onCLIRelaunchNeededCallback(async (sessionId) => {
  if (relaunchingSet.has(sessionId)) return;
  const info = launcher.getSession(sessionId);
  if (info?.archived) return;
  if (info && info.state !== "starting") {
    relaunchingSet.add(sessionId);
    console.log(`[server] Auto-relaunching CLI for session ${sessionId}`);
    try {
      await launcher.relaunch(sessionId);
    } finally {
      setTimeout(() => relaunchingSet.delete(sessionId), 5000);
    }
  }
});

console.log(`[server] Session persistence: ${sessionStore.directory}`);

const app = new Hono();

app.use("/api/*", cors());
app.route("/api", createRoutes(launcher, wsBridge, sessionStore));

// In production, serve built frontend using absolute path (works when installed as npm package)
if (process.env.NODE_ENV === "production") {
  const distDir = resolve(packageRoot, "dist");
  app.use("/*", serveStatic({ root: distDir }));
  app.get("/*", serveStatic({ path: resolve(distDir, "index.html") }));
}

const server = Bun.serve<SocketData>({
  port,
  fetch(req, server) {
    const url = new URL(req.url);

    // ── CLI WebSocket — Claude Code CLI connects here via --sdk-url ────
    const cliMatch = url.pathname.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
    if (cliMatch) {
      const sessionId = cliMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "cli" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // ── Browser WebSocket — connects to a specific session ─────────────
    const browserMatch = url.pathname.match(/^\/ws\/browser\/([a-f0-9-]+)$/);
    if (browserMatch) {
      const sessionId = browserMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "browser" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Hono handles the rest
    return app.fetch(req, server);
  },
  websocket: {
    open(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIOpen(ws, data.sessionId);
        launcher.markConnected(data.sessionId);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserOpen(ws, data.sessionId);
      }
    },
    message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIMessage(ws, msg);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserMessage(ws, msg);
      }
    },
    close(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIClose(ws);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserClose(ws);
      }
    },
  },
});

console.log(`Server running on http://localhost:${server.port}`);
console.log(`  CLI WebSocket:     ws://localhost:${server.port}/ws/cli/:sessionId`);
console.log(`  Browser WebSocket: ws://localhost:${server.port}/ws/browser/:sessionId`);

if (process.env.NODE_ENV !== "production") {
  console.log("Dev mode: frontend at http://localhost:2345");
}

// ── Reconnection watchdog ────────────────────────────────────────────────────
// After a server restart, restored CLI processes may not reconnect their
// WebSocket. Give them a grace period, then kill + relaunch any that are
// still in "starting" state (alive but no WS connection).
const RECONNECT_GRACE_MS = 10_000;
const starting = launcher.getStartingSessions();
if (starting.length > 0) {
  console.log(`[server] Waiting ${RECONNECT_GRACE_MS / 1000}s for ${starting.length} CLI process(es) to reconnect...`);
  setTimeout(async () => {
    const stale = launcher.getStartingSessions();
    for (const info of stale) {
      if (info.archived) continue;
      console.log(`[server] CLI for session ${info.sessionId} did not reconnect, relaunching...`);
      await launcher.relaunch(info.sessionId);
    }
  }, RECONNECT_GRACE_MS);
}
