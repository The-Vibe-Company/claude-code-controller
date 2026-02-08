import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import { ClaudeCodeController } from "../controller.js";
import type {
  ControllerOptions,
  LogLevel,
  TaskFile,
} from "../types.js";

// ─── Types (minimal, bridge-compatible) ───────────────────────────────────────

export type BridgeDecision = "approve" | "reject" | "grant" | "deny";

export interface SwarmBridgeOptions {
  /**
   * If omitted, the first call that needs a controller will create one with
   * `controllerOptions` (or defaults).
   */
  controller?: ClaudeCodeController | null;
  /**
   * Default options used when lazily creating a controller.
   */
  controllerOptions?: ControllerOptions & { logLevel?: LogLevel };
  /**
   * If set, require `Authorization: Bearer <apiKey>` for all endpoints except /health.
   */
  apiKey?: string;
  /**
   * Base path prefix for all routes (e.g. "/bridge").
   * Defaults to "/" (no prefix).
   */
  basePath?: string;
  /**
   * CORS configuration.
   * - `true` (default): enable CORS with permissive defaults (origin: *)
   * - `false`: disable CORS entirely
   */
  cors?: boolean;
}

interface BridgeEvent {
  event_id: string;
  event_type: string;
  timestamp: string;
  agent_id: string;
  payload: Record<string, unknown>;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const SAFE_AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_TASK_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /not found/i.test(err.message);
}

function validateAgentId(value: string, field = "agent_id"): void {
  if (!SAFE_AGENT_ID_RE.test(value)) {
    throw new ValidationError(
      `${field} must be 1-128 alphanumeric characters, hyphens, or underscores`
    );
  }
}

function validateTaskId(value: string): void {
  if (!SAFE_TASK_ID_RE.test(value)) {
    throw new ValidationError(
      "task_id must be 1-128 alphanumeric characters, hyphens, or underscores"
    );
  }
}

// ─── Event buffer/tracking ───────────────────────────────────────────────────

class SwarmEventBuffer {
  private events: BridgeEvent[] = [];
  private requestIndex = new Map<
    string,
    { kind: "plan" | "permission"; agentId: string }
  >();

  constructor(private maxEvents = 10_000) {}

  attach(ctrl: ClaudeCodeController): void {
    ctrl.on("message", (agentId, message) => {
      this.push("message:received", agentId, {
        content: message.text,
        summary: message.summary,
      });
    });

    ctrl.on("plan:approval_request", (agentId, msg) => {
      this.requestIndex.set(msg.requestId, { kind: "plan", agentId });
      this.push("plan:approval_request", agentId, {
        request_id: msg.requestId,
        plan_content: msg.planContent,
      });
    });

    ctrl.on("permission:request", (agentId, msg) => {
      this.requestIndex.set(msg.requestId, { kind: "permission", agentId });
      this.push("permission:request", agentId, {
        request_id: msg.requestId,
        tool_name: msg.toolName,
        description: msg.description,
        input: msg.input,
      });
    });

    ctrl.on("task:completed", (task) => {
      this.push("task:completed", task.owner ?? "", {
        task_id: task.id,
        subject: task.subject,
        status: task.status,
      });
    });

    ctrl.on("agent:spawned", (agentId, pid) => {
      this.push("agent:spawned", agentId, { pid });
    });
    ctrl.on("agent:exited", (agentId, code) => {
      this.push("agent:shutdown", agentId, { code });
    });
  }

  push(
    eventType: string,
    agentId: string,
    payload: Record<string, unknown> = {}
  ): BridgeEvent {
    const event: BridgeEvent = {
      event_id: randomUUID(),
      event_type: eventType,
      timestamp: new Date().toISOString(),
      agent_id: agentId,
      payload,
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return event;
  }

  list(opts?: { since?: string; limit?: number }): BridgeEvent[] {
    const limit = Math.max(0, Math.min(opts?.limit ?? 100, 1000));
    if (this.events.length === 0 || limit === 0) return [];

    let start = Math.max(0, this.events.length - limit);
    if (opts?.since) {
      const idx = this.events.findIndex((e) => e.event_id === opts.since);
      if (idx >= 0) start = Math.max(idx + 1, start);
    }

    return this.events.slice(start).slice(0, limit);
  }

  resolveRequest(
    requestId: string
  ): { kind: "plan" | "permission"; agentId: string } | undefined {
    return this.requestIndex.get(requestId);
  }
}

// ─── Controller state ────────────────────────────────────────────────────────

interface SwarmBridgeState {
  controller: ClaudeCodeController | null;
  owned: boolean;
  startTime: number;
  buffer: SwarmEventBuffer;
  apiKey?: string;
  initLock: boolean;
  controllerOptions?: ControllerOptions & { logLevel?: LogLevel };
}

async function ensureController(state: SwarmBridgeState): Promise<ClaudeCodeController> {
  if (state.controller) return state.controller;
  if (state.initLock) {
    throw new Error("Controller init already in progress");
  }
  state.initLock = true;
  try {
    const ctrl = new ClaudeCodeController({
      ...(state.controllerOptions ?? {}),
      logLevel: state.controllerOptions?.logLevel ?? "info",
    });
    await ctrl.init();
    state.controller = ctrl;
    state.owned = true;
    state.buffer.attach(ctrl);
    return ctrl;
  } finally {
    state.initLock = false;
  }
}

// ─── API ─────────────────────────────────────────────────────────────────────

export function createSwarmBridgeApi(opts?: SwarmBridgeOptions): Hono {
  const buffer = new SwarmEventBuffer();

  const state: SwarmBridgeState = {
    controller: opts?.controller ?? null,
    owned: false,
    startTime: Date.now(),
    buffer,
    apiKey: opts?.apiKey,
    initLock: false,
    controllerOptions: opts?.controllerOptions,
  };

  if (state.controller) {
    buffer.attach(state.controller);
  }

  const app = new Hono();
  const basePath = opts?.basePath ?? "/";

  if (opts?.cors !== false) {
    app.use("*", cors());
  }

  // Bearer auth (optional)
  app.use("*", async (c, next) => {
    if (c.req.path.endsWith("/health")) return next();
    if (!state.apiKey) return next();
    const authHeader = c.req.header("authorization");
    if (authHeader !== `Bearer ${state.apiKey}`) {
      return c.json(
        { error: "Unauthorized: invalid or missing Bearer token" },
        401
      );
    }
    return next();
  });

  const routes = new Hono();

  // Health
  routes.get("/health", async (c) => {
    const ctrl = state.controller;
    const agents_active = ctrl
      ? (await ctrl.team.getConfig()).members.filter(
          (m) => m.name !== "controller" && ctrl.isAgentRunning(m.name)
        ).length
      : 0;

    return c.json({
      status: "ok",
      agents_active,
      uptime_seconds: Math.floor((Date.now() - state.startTime) / 1000),
    });
  });

  // Spawn
  routes.post("/agents/spawn", async (c) => {
    const body = await c.req.json<{
      agent_id: string;
      system_prompt?: string;
      allowed_tools?: string[];
      model?: string;
    }>();

    if (!body.agent_id) throw new ValidationError("agent_id is required");
    validateAgentId(body.agent_id);

    const ctrl = await ensureController(state);
    await ctrl.spawnAgent({
      name: body.agent_id,
      model: body.model,
      permissions: body.allowed_tools,
    });

    // Best-effort system prompt injection (as first message)
    if (body.system_prompt && body.system_prompt.trim().length > 0) {
      await ctrl.send(body.agent_id, body.system_prompt, "system_prompt");
      state.buffer.push("message:sent", body.agent_id, {
        prompt_length: body.system_prompt.length,
        summary: "system_prompt",
      });
    }

    return c.json({ agent_id: body.agent_id, status: "spawned" }, 201);
  });

  // Ask (single-turn)
  routes.post("/agents/:id/ask", async (c) => {
    const agentId = c.req.param("id");
    validateAgentId(agentId, "agent_id");

    const body = await c.req.json<{ prompt: string; timeout_seconds?: number }>();
    if (!body.prompt || typeof body.prompt !== "string") {
      throw new ValidationError("prompt is required");
    }

    const ctrl = await ensureController(state);
    state.buffer.push("message:sent", agentId, {
      prompt_length: body.prompt.length,
    });

    await ctrl.send(agentId, body.prompt);
    const timeoutMs =
      body.timeout_seconds && body.timeout_seconds > 0
        ? Math.floor(body.timeout_seconds * 1000)
        : undefined;
    const messages = await ctrl.receive(agentId, {
      timeout: timeoutMs ?? 60_000,
    });

    const content = messages.map((m) => m.text).join("\n");
    state.buffer.push("message:received", agentId, {
      content_length: content.length,
    });

    return c.json({
      content,
      tool_calls: [],
      token_count: 0,
      cost_usd: 0,
    });
  });

  // Shutdown
  routes.post("/agents/:id/shutdown", async (c) => {
    const agentId = c.req.param("id");
    validateAgentId(agentId, "agent_id");
    const ctrl = await ensureController(state);

    try {
      await ctrl.sendShutdownRequest(agentId);
    } catch {
      // ignore
    }
    // Best-effort cleanup if still running
    if (ctrl.isAgentRunning(agentId)) {
      await ctrl.killAgent(agentId);
    }
    state.buffer.push("agent:shutdown", agentId);

    return c.json({ status: "shutdown", agent_id: agentId });
  });

  // Tasks
  routes.post("/tasks", async (c) => {
    const body = await c.req.json<{ subject: string; description: string; owner: string }>();
    if (!body.subject) throw new ValidationError("subject is required");
    if (!body.description) throw new ValidationError("description is required");
    if (!body.owner) throw new ValidationError("owner is required");
    validateAgentId(body.owner, "owner");

    const ctrl = await ensureController(state);
    const taskId = await ctrl.createTask({
      subject: body.subject,
      description: body.description,
      owner: body.owner,
    });
    const task = await ctrl.tasks.get(taskId);

    state.buffer.push("task:created", body.owner, { task_id: taskId });
    state.buffer.push("task:assigned", body.owner, { task_id: taskId, owner: body.owner });

    return c.json(taskToResponse(task), 201);
  });

  routes.get("/tasks/:id/wait", async (c) => {
    const taskId = c.req.param("id");
    validateTaskId(taskId);
    const ctrl = await ensureController(state);
    let task: TaskFile;
    try {
      task = await ctrl.tasks.get(taskId);
    } catch (err) {
      if (isNotFoundError(err)) {
        return c.json({ error: "Task not found" }, 404);
      }
      throw err;
    }
    return c.json(taskToResponse(task));
  });

  // Events
  routes.get("/events", async (c) => {
    const limitRaw = c.req.query("limit");
    const since = c.req.query("since");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const events = state.buffer.list({
      since: since || undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return c.json({ events });
  });

  // Governance
  routes.post("/governance/respond", async (c) => {
    const body = await c.req.json<{ request_id: string; decision: BridgeDecision; reason?: string }>();
    if (!body.request_id) throw new ValidationError("request_id is required");
    if (!body.decision) throw new ValidationError("decision is required");

    const ctrl = await ensureController(state);
    const resolved = state.buffer.resolveRequest(body.request_id);
    if (!resolved) {
      return c.json({ error: "Unknown request_id" }, 404);
    }

    if (resolved.kind === "plan") {
      const approved = body.decision === "approve";
      await ctrl.sendPlanApproval(
        resolved.agentId,
        body.request_id,
        approved,
        body.reason
      );
      state.buffer.push(
        approved ? "plan:approved" : "plan:rejected",
        resolved.agentId,
        { request_id: body.request_id, reason: body.reason }
      );
    } else {
      const granted = body.decision === "grant";
      await ctrl.sendPermissionResponse(resolved.agentId, body.request_id, granted);
      state.buffer.push(
        granted ? "permission:granted" : "permission:denied",
        resolved.agentId,
        { request_id: body.request_id, reason: body.reason }
      );
    }

    return c.json({ ok: true });
  });

  app.route(basePath, routes);

  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = err instanceof Error && err.name === "ValidationError" ? 400 : 500;
    return c.json({ error: message }, status);
  });

  return app;
}

function taskToResponse(task: TaskFile): Record<string, unknown> {
  return {
    task_id: task.id,
    agent_id: task.owner ?? "",
    subject: task.subject,
    description: task.description,
    owner: task.owner ?? "",
    status: task.status === "completed" ? "completed" : task.status,
    result: task.metadata?.result as string | undefined,
    duration_ms: 0,
    tools_used: [],
    timestamp: new Date().toISOString(),
  };
}
