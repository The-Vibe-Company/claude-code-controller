import { Hono } from "hono";
import type { ClaudeCodeController } from "../controller.js";
import type {
  SpawnAgentBody,
  SendMessageBody,
  BroadcastBody,
  ApprovePlanBody,
  ApprovePermissionBody,
  CreateTaskBody,
  UpdateTaskBody,
  AssignTaskBody,
} from "./types.js";

const startTime = Date.now();

export function buildRoutes(controller: ClaudeCodeController) {
  const api = new Hono();

  // ─── Health ──────────────────────────────────────────────────────────

  api.get("/health", (c) => {
    return c.json({ status: "ok", uptime: Date.now() - startTime });
  });

  // ─── Session ─────────────────────────────────────────────────────────

  api.get("/session", (c) => {
    return c.json({
      initialized: true,
      teamName: controller.teamName,
    });
  });

  api.post("/session/shutdown", async (c) => {
    await controller.shutdown();
    return c.json({ ok: true });
  });

  // ─── Agents ──────────────────────────────────────────────────────────

  api.get("/agents", async (c) => {
    const config = await controller.team.getConfig();
    const agents = config.members
      .filter((m) => m.name !== "controller")
      .map((m) => ({
        name: m.name,
        type: m.agentType,
        model: m.model,
        running: controller.isAgentRunning(m.name),
      }));
    return c.json(agents);
  });

  api.post("/agents", async (c) => {
    const body = await c.req.json<SpawnAgentBody>();
    if (!body.name) {
      return c.json({ error: "name is required" }, 400);
    }

    const handle = await controller.spawnAgent({
      name: body.name,
      type: body.type,
      model: body.model,
      cwd: body.cwd,
      permissions: body.permissions,
      env: body.env,
    });

    return c.json(
      {
        name: handle.name,
        pid: handle.pid,
        running: handle.isRunning,
      },
      201
    );
  });

  api.get("/agents/:name", async (c) => {
    const name = c.req.param("name");
    const config = await controller.team.getConfig();
    const member = config.members.find((m) => m.name === name);
    if (!member) {
      return c.json({ error: `Agent "${name}" not found` }, 404);
    }
    return c.json({
      name: member.name,
      type: member.agentType,
      model: member.model,
      running: controller.isAgentRunning(name),
    });
  });

  api.post("/agents/:name/messages", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json<SendMessageBody>();
    if (!body.message) {
      return c.json({ error: "message is required" }, 400);
    }
    await controller.send(name, body.message, body.summary);
    return c.json({ ok: true });
  });

  api.post("/agents/:name/kill", async (c) => {
    const name = c.req.param("name");
    await controller.killAgent(name);
    return c.json({ ok: true });
  });

  api.post("/agents/:name/shutdown", async (c) => {
    const name = c.req.param("name");
    await controller.sendShutdownRequest(name);
    return c.json({ ok: true });
  });

  api.post("/agents/:name/approve-plan", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json<ApprovePlanBody>();
    if (!body.requestId) {
      return c.json({ error: "requestId is required" }, 400);
    }
    await controller.sendPlanApproval(
      name,
      body.requestId,
      body.approve ?? true,
      body.feedback
    );
    return c.json({ ok: true });
  });

  api.post("/agents/:name/approve-permission", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json<ApprovePermissionBody>();
    if (!body.requestId) {
      return c.json({ error: "requestId is required" }, 400);
    }
    await controller.sendPermissionResponse(
      name,
      body.requestId,
      body.approve ?? true
    );
    return c.json({ ok: true });
  });

  // ─── Broadcast ───────────────────────────────────────────────────────

  api.post("/broadcast", async (c) => {
    const body = await c.req.json<BroadcastBody>();
    if (!body.message) {
      return c.json({ error: "message is required" }, 400);
    }
    await controller.broadcast(body.message, body.summary);
    return c.json({ ok: true });
  });

  // ─── Tasks ───────────────────────────────────────────────────────────

  api.get("/tasks", async (c) => {
    const tasks = await controller.tasks.list();
    return c.json(tasks);
  });

  api.post("/tasks", async (c) => {
    const body = await c.req.json<CreateTaskBody>();
    if (!body.subject || !body.description) {
      return c.json({ error: "subject and description are required" }, 400);
    }
    const taskId = await controller.createTask(body);
    const task = await controller.tasks.get(taskId);
    return c.json(task, 201);
  });

  api.get("/tasks/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const task = await controller.tasks.get(id);
      return c.json(task);
    } catch {
      return c.json({ error: `Task "${id}" not found` }, 404);
    }
  });

  api.patch("/tasks/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<UpdateTaskBody>();
    try {
      const task = await controller.tasks.update(id, body);
      return c.json(task);
    } catch {
      return c.json({ error: `Task "${id}" not found` }, 404);
    }
  });

  api.delete("/tasks/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await controller.tasks.delete(id);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: `Task "${id}" not found` }, 404);
    }
  });

  api.post("/tasks/:id/assign", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<AssignTaskBody>();
    if (!body.agent) {
      return c.json({ error: "agent is required" }, 400);
    }
    try {
      await controller.assignTask(id, body.agent);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: `Task "${id}" not found` }, 404);
    }
  });

  return api;
}
