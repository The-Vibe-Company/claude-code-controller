import { Hono } from "hono";
import type { ClaudeCodeController } from "../controller.js";
import { buildRoutes } from "./routes.js";
import type { CreateApiOptions } from "./types.js";

/**
 * Create a standalone Hono app that exposes a ClaudeCodeController as a REST API.
 *
 * The controller must already be initialized (via `controller.init()`) before
 * passing it to this function.
 *
 * @example
 * ```ts
 * import { ClaudeCodeController } from "claude-code-controller";
 * import { createApi } from "claude-code-controller/api";
 *
 * const controller = new ClaudeCodeController({ teamName: "my-team" });
 * await controller.init();
 *
 * const app = createApi(controller);
 *
 * // Serve with Bun
 * Bun.serve({ port: 3000, fetch: app.fetch });
 *
 * // Or with Node.js (via @hono/node-server)
 * // import { serve } from "@hono/node-server";
 * // serve({ fetch: app.fetch, port: 3000 });
 * ```
 */
export function createApi(
  controller: ClaudeCodeController,
  options?: CreateApiOptions
): Hono {
  const app = new Hono();
  const routes = buildRoutes(controller);
  const basePath = options?.basePath ?? "/";

  app.route(basePath, routes);

  // Global error handler
  app.onError((err, c) => {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return c.json({ error: message }, 500);
  });

  return app;
}

// Re-export types for consumers
export type {
  CreateApiOptions,
  InitSessionBody,
  SpawnAgentBody,
  SendMessageBody,
  BroadcastBody,
  ApprovePlanBody,
  ApprovePermissionBody,
  CreateTaskBody,
  UpdateTaskBody,
  AssignTaskBody,
  ApiError,
  AgentResponse,
  SessionResponse,
  HealthResponse,
} from "./types.js";
