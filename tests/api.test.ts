import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const tempBase = mkdtempSync(join(tmpdir(), "cc-api-test-"));

mock.module("../src/paths.js", () => ({
  teamsDir: () => join(tempBase, "teams"),
  teamDir: (name: string) => join(tempBase, "teams", name),
  teamConfigPath: (name: string) =>
    join(tempBase, "teams", name, "config.json"),
  inboxesDir: (name: string) => join(tempBase, "teams", name, "inboxes"),
  inboxPath: (name: string, agent: string) =>
    join(tempBase, "teams", name, "inboxes", `${agent}.json`),
  tasksBaseDir: () => join(tempBase, "tasks"),
  tasksDir: (name: string) => join(tempBase, "tasks", name),
  taskPath: (name: string, id: string) =>
    join(tempBase, "tasks", name, `${id}.json`),
  _tempBase: tempBase,
}));

const { ClaudeCodeController } = await import("../src/controller.js");
const { createApi } = await import("../src/api/index.js");
const { readInbox } = await import("../src/inbox.js");

describe("createApi", () => {
  let ctrl: InstanceType<typeof ClaudeCodeController>;
  let teamName: string;
  let app: ReturnType<typeof createApi>;

  beforeEach(async () => {
    teamName = `api-${randomUUID().slice(0, 8)}`;
    ctrl = new ClaudeCodeController({
      teamName,
      logLevel: "silent",
    });
    await ctrl.init();
    app = createApi(ctrl);
  });

  afterEach(async () => {
    try {
      await ctrl.shutdown();
    } catch {
      // Controller may already be shut down (e.g. error handling test)
    }
  });

  // ─── Health ──────────────────────────────────────────────────────────

  it("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });

  // ─── Session ─────────────────────────────────────────────────────────

  it("GET /session returns session info", async () => {
    const res = await app.request("/session");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.initialized).toBe(true);
    expect(body.teamName).toBe(teamName);
  });

  // ─── Agents ──────────────────────────────────────────────────────────

  it("GET /agents returns empty list initially", async () => {
    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("POST /agents returns 400 without name", async () => {
    const res = await app.request("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("name");
  });

  it("GET /agents/:name returns 404 for unknown agent", async () => {
    const res = await app.request("/agents/nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  it("GET /agents/:name returns agent after it's registered", async () => {
    // Register a member directly via team manager
    await ctrl.team.addMember({
      agentId: `worker1@${teamName}`,
      name: "worker1",
      agentType: "general-purpose",
      joinedAt: Date.now(),
      cwd: "/tmp",
    });

    const res = await app.request("/agents/worker1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("worker1");
    expect(body.type).toBe("general-purpose");
    expect(body.running).toBe(false);
  });

  it("GET /agents lists registered agents (excluding controller)", async () => {
    await ctrl.team.addMember({
      agentId: `w1@${teamName}`,
      name: "w1",
      agentType: "Bash",
      joinedAt: Date.now(),
      cwd: "/tmp",
    });

    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("w1");
    expect(body[0].type).toBe("Bash");
  });

  // ─── Messages ────────────────────────────────────────────────────────

  it("POST /agents/:name/messages sends a message", async () => {
    const res = await app.request("/agents/worker1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello agent", summary: "greeting" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify message landed in inbox
    const inbox = await readInbox(teamName, "worker1");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].text).toBe("Hello agent");
    expect(inbox[0].from).toBe("controller");
    expect(inbox[0].summary).toBe("greeting");
  });

  it("POST /agents/:name/messages returns 400 without message", async () => {
    const res = await app.request("/agents/worker1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // ─── Broadcast ───────────────────────────────────────────────────────

  it("POST /broadcast sends to all agents", async () => {
    await ctrl.team.addMember({
      agentId: `a1@${teamName}`,
      name: "a1",
      agentType: "general-purpose",
      joinedAt: Date.now(),
      cwd: "/tmp",
    });
    await ctrl.team.addMember({
      agentId: `a2@${teamName}`,
      name: "a2",
      agentType: "general-purpose",
      joinedAt: Date.now(),
      cwd: "/tmp",
    });

    const res = await app.request("/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello everyone" }),
    });
    expect(res.status).toBe(200);

    const inbox1 = await readInbox(teamName, "a1");
    const inbox2 = await readInbox(teamName, "a2");
    expect(inbox1).toHaveLength(1);
    expect(inbox1[0].text).toBe("Hello everyone");
    expect(inbox2).toHaveLength(1);
    expect(inbox2[0].text).toBe("Hello everyone");
  });

  it("POST /broadcast returns 400 without message", async () => {
    const res = await app.request("/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // ─── Plan Approval ───────────────────────────────────────────────────

  it("POST /agents/:name/approve-plan sends approval", async () => {
    const res = await app.request("/agents/coder/approve-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "plan-abc",
        approve: true,
        feedback: "LGTM",
      }),
    });
    expect(res.status).toBe(200);

    const inbox = await readInbox(teamName, "coder");
    expect(inbox).toHaveLength(1);
    const parsed = JSON.parse(inbox[0].text);
    expect(parsed.type).toBe("plan_approval_response");
    expect(parsed.approved).toBe(true);
    expect(parsed.feedback).toBe("LGTM");
  });

  it("POST /agents/:name/approve-plan returns 400 without requestId", async () => {
    const res = await app.request("/agents/coder/approve-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve: true }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /agents/:name/approve-plan defaults approve to true", async () => {
    const res = await app.request("/agents/coder/approve-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "plan-xyz" }),
    });
    expect(res.status).toBe(200);

    const inbox = await readInbox(teamName, "coder");
    const parsed = JSON.parse(inbox[0].text);
    expect(parsed.approved).toBe(true);
  });

  // ─── Permission Approval ─────────────────────────────────────────────

  it("POST /agents/:name/approve-permission sends response", async () => {
    const res = await app.request("/agents/worker1/approve-permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "perm-42", approve: false }),
    });
    expect(res.status).toBe(200);

    const inbox = await readInbox(teamName, "worker1");
    const parsed = JSON.parse(inbox[0].text);
    expect(parsed.type).toBe("permission_response");
    expect(parsed.approved).toBe(false);
  });

  it("POST /agents/:name/approve-permission returns 400 without requestId", async () => {
    const res = await app.request("/agents/worker1/approve-permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // ─── Tasks ───────────────────────────────────────────────────────────

  it("GET /tasks returns empty list initially", async () => {
    const res = await app.request("/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("POST /tasks creates a task", async () => {
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: "Fix bug",
        description: "Fix the login bug",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.subject).toBe("Fix bug");
    expect(body.description).toBe("Fix the login bug");
    expect(body.status).toBe("pending");
    expect(body.id).toBe("1");
  });

  it("POST /tasks returns 400 without subject", async () => {
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "no subject" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /tasks with owner sends assignment message", async () => {
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: "Build feature",
        description: "Build the new feature",
        owner: "worker1",
      }),
    });
    expect(res.status).toBe(201);

    const inbox = await readInbox(teamName, "worker1");
    expect(inbox).toHaveLength(1);
    const parsed = JSON.parse(inbox[0].text);
    expect(parsed.type).toBe("task_assignment");
    expect(parsed.subject).toBe("Build feature");
  });

  it("GET /tasks/:id returns a task", async () => {
    await ctrl.createTask({ subject: "Task 1", description: "Desc 1" });

    const res = await app.request("/tasks/1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subject).toBe("Task 1");
  });

  it("GET /tasks/:id returns 404 for unknown task", async () => {
    const res = await app.request("/tasks/999");
    expect(res.status).toBe(404);
  });

  it("PATCH /tasks/:id updates a task", async () => {
    await ctrl.createTask({ subject: "Task 1", description: "Desc 1" });

    const res = await app.request("/tasks/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("in_progress");
  });

  it("DELETE /tasks/:id deletes a task", async () => {
    await ctrl.createTask({ subject: "Task 1", description: "Desc 1" });

    const res = await app.request("/tasks/1", { method: "DELETE" });
    expect(res.status).toBe(200);

    // Should be gone now
    const res2 = await app.request("/tasks/1");
    expect(res2.status).toBe(404);
  });

  it("POST /tasks/:id/assign assigns a task", async () => {
    await ctrl.createTask({ subject: "Task 1", description: "Desc 1" });

    const res = await app.request("/tasks/1/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "worker1" }),
    });
    expect(res.status).toBe(200);

    // Task should have owner set
    const task = await ctrl.tasks.get("1");
    expect(task.owner).toBe("worker1");

    // Assignment message should be in inbox
    const inbox = await readInbox(teamName, "worker1");
    expect(inbox).toHaveLength(1);
    const parsed = JSON.parse(inbox[0].text);
    expect(parsed.type).toBe("task_assignment");
  });

  it("POST /tasks/:id/assign returns 400 without agent", async () => {
    await ctrl.createTask({ subject: "Task 1", description: "Desc 1" });

    const res = await app.request("/tasks/1/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("GET /tasks lists all tasks", async () => {
    await ctrl.createTask({ subject: "Task 1", description: "Desc 1" });
    await ctrl.createTask({ subject: "Task 2", description: "Desc 2" });

    const res = await app.request("/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  // ─── Agent Shutdown ──────────────────────────────────────────────────

  it("POST /agents/:name/shutdown sends shutdown request", async () => {
    const res = await app.request("/agents/worker1/shutdown", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const inbox = await readInbox(teamName, "worker1");
    expect(inbox).toHaveLength(1);
    const parsed = JSON.parse(inbox[0].text);
    expect(parsed.type).toBe("shutdown_request");
  });

  // ─── Base Path ───────────────────────────────────────────────────────

  it("supports basePath option", async () => {
    const prefixed = createApi(ctrl, { basePath: "/api/v1" });

    const res = await prefixed.request("/api/v1/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  // ─── Error Handling ──────────────────────────────────────────────────

  it("returns 500 on internal errors via error handler", async () => {
    // Shut down the controller to trigger errors on operations
    await ctrl.shutdown();

    const res = await app.request("/agents/worker1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "will fail" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});
