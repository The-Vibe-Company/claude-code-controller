process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { createRoutes } from "./routes.js";
import { CliLauncher } from "./cli-launcher.js";
import { WsBridge } from "./ws-bridge.js";
import type { SocketData } from "./ws-bridge.js";
import type { ServerWebSocket } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.__VIBE_PACKAGE_ROOT || resolve(__dirname, "..");

function getValidatedHost(envHost: string | undefined): string {
  const fallbackHost = "127.0.0.1";

  if (!envHost) {
    return fallbackHost;
  }

  const trimmed = envHost.trim();

  if (!trimmed) {
    return fallbackHost;
  }

  // Disallow any whitespace inside the host value to avoid confusing Bun.serve errors.
  if (/\s/.test(trimmed)) {
    throw new Error(
      `Invalid HOST environment variable "${envHost}": value must not contain whitespace`,
    );
  }

  return trimmed;
}

const port = Number(process.env.PORT) || 3456;
const host = getValidatedHost(process.env.HOST);
const wsBridge = new WsBridge();
const launcher = new CliLauncher(host, port);

const app = new Hono();

app.use("/api/*", cors());
app.route("/api", createRoutes(launcher, wsBridge));

// In production, serve built frontend using absolute path (works when installed as npm package)
if (process.env.NODE_ENV === "production") {
  const distDir = resolve(packageRoot, "dist");
  app.use("/*", serveStatic({ root: distDir }));
  app.get("/*", serveStatic({ path: resolve(distDir, "index.html") }));
}

const server = Bun.serve<SocketData>({
  hostname: host,
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

console.log(`Server running on http://${host}:${server.port}`);
console.log(`  CLI WebSocket:     ws://${host}:${server.port}/ws/cli/:sessionId`);
console.log(`  Browser WebSocket: ws://${host}:${server.port}/ws/browser/:sessionId`);

// In dev mode, log that Vite should be run separately
if (process.env.NODE_ENV !== "production") {
  console.log("Dev mode: run 'bun run dev:vite' in another terminal for the frontend");
}
