import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const tempBase = mkdtempSync(join(tmpdir(), "cc-api-test-"));

mock.module("../src/paths.js", () => {
  const makePaths = (base: string) => ({
    claudeDir: base,
    teamsDir: () => join(base, "teams"),
    teamDir: (name: string) => join(base, "teams", name),
    teamConfigPath: (name: string) =>
      join(base, "teams", name, "config.json"),
    inboxesDir: (name: string) => join(base, "teams", name, "inboxes"),
    inboxPath: (name: string, agent: string) =>
      join(base, "teams", name, "inboxes", `${agent}.json`),
    tasksBaseDir: () => join(base, "tasks"),
    tasksDir: (name: string) => join(base, "tasks", name),
    taskPath: (name: string, id: string) =>
      join(base, "tasks", name, `${id}.json`),
  });

  const defaultPaths = makePaths(tempBase);
  const createPaths = (opts?: { claudeDir?: string }) =>
    makePaths(opts?.claudeDir ?? tempBase);

  return {
    createPaths,
    defaultPaths,
    teamsDir: defaultPaths.teamsDir,
    teamDir: defaultPaths.teamDir,
    teamConfigPath: defaultPaths.teamConfigPath,
    inboxesDir: defaultPaths.inboxesDir,
    inboxPath: defaultPaths.inboxPath,
    tasksBaseDir: defaultPaths.tasksBaseDir,
    tasksDir: defaultPaths.tasksDir,
    taskPath: defaultPaths.taskPath,
    _tempBase: tempBase,
  };
});

const { ClaudeCodeController } = await import("../src/controller.js");
const { createApi } = await import("../src/api/index.js");
const { readInbox, writeInbox } = await import("../src/inbox.js");

// ─── Pre-initialized controller mode ─────────────────────────────────────────

describe("createApi (pre-initialized controller)", () => {
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
      // Controller may already be shut down
    }
  });

  // ─── Health ──────────────────────────────────────────────────────────

  it("GET /health returns ok with session status", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(body.session).toBe(true);
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

    const task = await ctrl.tasks.get("1");
    expect(task.owner).toBe("worker1");

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

// ─── Session init mode (lazy) ────────────────────────────────────────────────

describe("createApi (session init mode)", () => {
  let app: ReturnType<typeof createApi>;
  let teamName: string;

  beforeEach(() => {
    teamName = `init-${randomUUID().slice(0, 8)}`;
    app = createApi(); // No controller passed
  });

  afterEach(async () => {
    try {
      await app.request("/session/shutdown", { method: "POST" });
    } catch {
      // Already shut down or never initialized
    }
  });

  it("GET /session returns not initialized before init", async () => {
    const res = await app.request("/session");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.initialized).toBe(false);
  });

  it("GET /health shows session: false before init", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toBe(false);
  });

  it("GET /agents returns 500 before init", async () => {
    const res = await app.request("/agents");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("No active session");
  });

  it("POST /session/init creates a session with env", async () => {
    const res = await app.request("/session/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamName,
        env: { MY_CUSTOM_VAR: "hello" },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.initialized).toBe(true);
    expect(body.teamName).toBe(teamName);
  });

  it("POST /session/init allows usage of API afterwards", async () => {
    await app.request("/session/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName }),
    });

    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("POST /session/init can send messages after init", async () => {
    await app.request("/session/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName }),
    });

    const res = await app.request("/agents/worker1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello from init mode" }),
    });
    expect(res.status).toBe(200);

    const inbox = await readInbox(teamName, "worker1");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].text).toBe("Hello from init mode");
  });

  it("POST /session/init with empty body uses defaults", async () => {
    const res = await app.request("/session/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.initialized).toBe(true);
    expect(body.teamName).toBeTruthy();
  });

  it("POST /session/init replaces existing session", async () => {
    await app.request("/session/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName }),
    });

    const teamName2 = `reinit-${randomUUID().slice(0, 8)}`;
    const res2 = await app.request("/session/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName: teamName2 }),
    });
    expect(res2.status).toBe(201);
    const body2 = await res2.json();
    expect(body2.teamName).toBe(teamName2);

    const res3 = await app.request("/session");
    const body3 = await res3.json();
    expect(body3.teamName).toBe(teamName2);
  });

  it("POST /session/shutdown after init works", async () => {
    await app.request("/session/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName }),
    });

    const res = await app.request("/session/shutdown", { method: "POST" });
    expect(res.status).toBe(200);

    const session = await app.request("/session");
    const body = await session.json();
    expect(body.initialized).toBe(false);
  });
});

// ─── Actions endpoints ───────────────────────────────────────────────────────

describe("createApi /actions", () => {
  let ctrl: InstanceType<typeof ClaudeCodeController>;
  let teamName: string;
  let app: ReturnType<typeof createApi>;

  beforeEach(async () => {
    teamName = `act-${randomUUID().slice(0, 8)}`;
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
      // Already shut down
    }
  });

  it("GET /actions returns empty state initially", async () => {
    const res = await app.request("/actions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending).toBe(0);
    expect(body.approvals).toEqual([]);
    expect(body.unassignedTasks).toEqual([]);
    expect(body.idleAgents).toEqual([]);
  });

  it("GET /actions includes unassigned tasks", async () => {
    await ctrl.createTask({ subject: "Task A", description: "Unassigned" });
    await ctrl.createTask({
      subject: "Task B",
      description: "Assigned",
      owner: "worker1",
    });

    const res = await app.request("/actions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unassignedTasks).toHaveLength(1);
    expect(body.unassignedTasks[0].subject).toBe("Task A");
    expect(body.unassignedTasks[0].action).toBe("POST /tasks/1/assign");
    expect(body.pending).toBe(1);
  });

  it("GET /actions excludes completed unassigned tasks", async () => {
    const id = await ctrl.createTask({
      subject: "Done task",
      description: "Already done",
    });
    await ctrl.tasks.update(id, { status: "completed" });

    const res = await app.request("/actions");
    const body = await res.json();
    expect(body.unassignedTasks).toHaveLength(0);
  });

  it("GET /actions tracks plan approval requests", async () => {
    const planMsg = JSON.stringify({
      type: "plan_approval_request",
      requestId: "plan-123",
      from: "coder",
      planContent: "Step 1: do stuff",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(teamName, "controller", {
      from: "coder",
      text: planMsg,
      timestamp: new Date().toISOString(),
    });

    // @ts-expect-error accessing private
    await ctrl.poller.poll();

    const res = await app.request("/actions");
    const body = await res.json();
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0].type).toBe("plan");
    expect(body.approvals[0].agent).toBe("coder");
    expect(body.approvals[0].requestId).toBe("plan-123");
    expect(body.approvals[0].action).toBe(
      "POST /agents/coder/approve-plan"
    );
    expect(body.pending).toBe(1);
  });

  it("GET /actions tracks permission requests", async () => {
    const permMsg = JSON.stringify({
      type: "permission_request",
      requestId: "perm-456",
      from: "worker1",
      toolName: "Write",
      description: "Write to /tmp/foo.txt",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: permMsg,
      timestamp: new Date().toISOString(),
    });

    // @ts-expect-error accessing private
    await ctrl.poller.poll();

    const res = await app.request("/actions");
    const body = await res.json();
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0].type).toBe("permission");
    expect(body.approvals[0].toolName).toBe("Write");
    expect(body.approvals[0].action).toBe(
      "POST /agents/worker1/approve-permission"
    );
  });

  it("approve-plan resolves the approval from actions", async () => {
    const planMsg = JSON.stringify({
      type: "plan_approval_request",
      requestId: "plan-resolve",
      from: "coder",
      planContent: "Plan content",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(teamName, "controller", {
      from: "coder",
      text: planMsg,
      timestamp: new Date().toISOString(),
    });
    // @ts-expect-error accessing private
    await ctrl.poller.poll();

    let res = await app.request("/actions");
    let body = await res.json();
    expect(body.approvals).toHaveLength(1);

    await app.request("/agents/coder/approve-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "plan-resolve", approve: true }),
    });

    res = await app.request("/actions");
    body = await res.json();
    expect(body.approvals).toHaveLength(0);
    expect(body.pending).toBe(0);
  });

  it("approve-permission resolves the approval from actions", async () => {
    const permMsg = JSON.stringify({
      type: "permission_request",
      requestId: "perm-resolve",
      from: "worker1",
      toolName: "Bash",
      description: "Run ls",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: permMsg,
      timestamp: new Date().toISOString(),
    });
    // @ts-expect-error accessing private
    await ctrl.poller.poll();

    await app.request("/agents/worker1/approve-permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "perm-resolve" }),
    });

    const res = await app.request("/actions");
    const body = await res.json();
    expect(body.approvals).toHaveLength(0);
  });

  it("GET /actions tracks idle agents", async () => {
    const idleMsg = JSON.stringify({
      type: "idle_notification",
      from: "worker1",
      timestamp: new Date().toISOString(),
      idleReason: "turn_ended",
    });
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: idleMsg,
      timestamp: new Date().toISOString(),
    });
    // @ts-expect-error accessing private
    await ctrl.poller.poll();

    const res = await app.request("/actions");
    const body = await res.json();
    expect(body.idleAgents).toHaveLength(1);
    expect(body.idleAgents[0].name).toBe("worker1");
    expect(body.idleAgents[0].action).toBe(
      "POST /agents/worker1/messages"
    );
    expect(body.pending).toBe(1);
  });

  it("idle agent is cleared when it sends a message", async () => {
    const idleMsg = JSON.stringify({
      type: "idle_notification",
      from: "worker1",
      timestamp: new Date().toISOString(),
      idleReason: "turn_ended",
    });
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: idleMsg,
      timestamp: new Date().toISOString(),
    });
    // @ts-expect-error accessing private
    await ctrl.poller.poll();

    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: "I'm back!",
      timestamp: new Date().toISOString(),
    });
    // @ts-expect-error accessing private
    await ctrl.poller.poll();

    const res = await app.request("/actions");
    const body = await res.json();
    expect(body.idleAgents).toHaveLength(0);
  });

  // ─── Sub-routes ──────────────────────────────────────────────────────

  it("GET /actions/approvals returns only approvals", async () => {
    const res = await app.request("/actions/approvals");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("GET /actions/tasks returns only unassigned tasks", async () => {
    await ctrl.createTask({ subject: "T", description: "D" });

    const res = await app.request("/actions/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].subject).toBe("T");
  });

  it("GET /actions/idle-agents returns only idle agents", async () => {
    const res = await app.request("/actions/idle-agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  // ─── Aggregated pending count ────────────────────────────────────────

  it("GET /actions aggregates pending count correctly", async () => {
    await ctrl.createTask({ subject: "T", description: "D" });

    const planMsg = JSON.stringify({
      type: "plan_approval_request",
      requestId: "plan-count",
      from: "coder",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(teamName, "controller", {
      from: "coder",
      text: planMsg,
      timestamp: new Date().toISOString(),
    });

    const idleMsg = JSON.stringify({
      type: "idle_notification",
      from: "worker1",
      timestamp: new Date().toISOString(),
      idleReason: "available",
    });
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: idleMsg,
      timestamp: new Date().toISOString(),
    });

    // @ts-expect-error accessing private
    await ctrl.poller.poll();

    const res = await app.request("/actions");
    const body = await res.json();
    expect(body.pending).toBe(3);
    expect(body.approvals).toHaveLength(1);
    expect(body.unassignedTasks).toHaveLength(1);
    expect(body.idleAgents).toHaveLength(1);
  });

  // ─── Stale approvals cleanup on agent exit ─────────────────────────

  it("agent exit clears stale approvals for that agent", async () => {
    // Create a pending plan approval
    const planMsg = JSON.stringify({
      type: "plan_approval_request",
      requestId: "plan-stale",
      from: "deadagent",
      planContent: "Will never complete",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(teamName, "controller", {
      from: "deadagent",
      text: planMsg,
      timestamp: new Date().toISOString(),
    });
    // @ts-expect-error accessing private
    await ctrl.poller.poll();

    let res = await app.request("/actions");
    let body = await res.json();
    expect(body.approvals).toHaveLength(1);

    // Simulate agent exit
    ctrl.emit("agent:exited", "deadagent", 1);

    res = await app.request("/actions");
    body = await res.json();
    expect(body.approvals).toHaveLength(0);
  });
});

// ─── Validation / Security ───────────────────────────────────────────────────

describe("createApi validation", () => {
  it("POST /session/init rejects path traversal in teamName", async () => {
    const app = createApi();
    const res = await app.request("/session/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName: "../../etc" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("teamName");
  });

  it("POST /session/init rejects dots in teamName", async () => {
    const app = createApi();
    const res = await app.request("/session/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName: "foo.bar" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /agents rejects path traversal in name", async () => {
    const teamName = `val-${randomUUID().slice(0, 8)}`;
    const ctrl = new ClaudeCodeController({ teamName, logLevel: "silent" });
    await ctrl.init();
    const app = createApi(ctrl);

    const res = await app.request("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "../controller" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("name");

    await ctrl.shutdown();
  });

  it("GET /agents/:name rejects path traversal", async () => {
    const teamName = `val-${randomUUID().slice(0, 8)}`;
    const ctrl = new ClaudeCodeController({ teamName, logLevel: "silent" });
    await ctrl.init();
    const app = createApi(ctrl);

    const res = await app.request("/agents/..%2Fcontroller", { method: "GET" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("name");

    await ctrl.shutdown();
  });

  it("POST /agents/:name/messages rejects path traversal", async () => {
    const teamName = `val-${randomUUID().slice(0, 8)}`;
    const ctrl = new ClaudeCodeController({ teamName, logLevel: "silent" });
    await ctrl.init();
    const app = createApi(ctrl);

    const res = await app.request("/agents/..%2Fevil/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(400);

    await ctrl.shutdown();
  });

  it("POST /tasks/:id/assign rejects path traversal in agent name", async () => {
    const teamName = `val-${randomUUID().slice(0, 8)}`;
    const ctrl = new ClaudeCodeController({ teamName, logLevel: "silent" });
    await ctrl.init();
    const app = createApi(ctrl);

    const task = await ctrl.createTask({ subject: "test", description: "test" });
    const res = await app.request(`/tasks/${task}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "../../../etc" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("agent");

    await ctrl.shutdown();
  });

  it("GET /tasks/:id rejects path traversal in task id", async () => {
    const teamName = `val-${randomUUID().slice(0, 8)}`;
    const ctrl = new ClaudeCodeController({ teamName, logLevel: "silent" });
    await ctrl.init();
    const app = createApi(ctrl);

    const res = await app.request("/tasks/..%2F..%2Fetc%2Fpasswd", { method: "GET" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("task id");

    await ctrl.shutdown();
  });

  it("PATCH /tasks/:id rejects non-numeric task id", async () => {
    const teamName = `val-${randomUUID().slice(0, 8)}`;
    const ctrl = new ClaudeCodeController({ teamName, logLevel: "silent" });
    await ctrl.init();
    const app = createApi(ctrl);

    const res = await app.request("/tasks/abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(res.status).toBe(400);

    await ctrl.shutdown();
  });

  it("DELETE /tasks/:id rejects path traversal", async () => {
    const teamName = `val-${randomUUID().slice(0, 8)}`;
    const ctrl = new ClaudeCodeController({ teamName, logLevel: "silent" });
    await ctrl.init();
    const app = createApi(ctrl);

    const res = await app.request("/tasks/..%2Fconfig", { method: "DELETE" });
    expect(res.status).toBe(400);

    await ctrl.shutdown();
  });

  it("POST /session/init accepts valid names with hyphens and underscores", async () => {
    const app = createApi();
    const res = await app.request("/session/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName: "my-team_01" }),
    });
    // Should succeed (valid name)
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.teamName).toBe("my-team_01");

    await app.request("/session/shutdown", { method: "POST" });
  });
});

// ─── Mode 1 shutdown safety ──────────────────────────────────────────────────

describe("createApi Mode 1 shutdown safety", () => {
  it("POST /session/shutdown does NOT shut down externally-provided controller", async () => {
    const teamName = `m1-${randomUUID().slice(0, 8)}`;
    const ctrl = new ClaudeCodeController({ teamName, logLevel: "silent" });
    await ctrl.init();
    const app = createApi(ctrl);

    // Shutdown via API
    const res = await app.request("/session/shutdown", { method: "POST" });
    expect(res.status).toBe(200);

    // API should show no session
    const session = await app.request("/session");
    const body = await session.json();
    expect(body.initialized).toBe(false);

    // But the controller itself should still be functional
    // (send should not throw "Controller not initialized")
    await ctrl.send("test-agent", "hello");
    const inbox = await readInbox(teamName, "test-agent");
    expect(inbox).toHaveLength(1);

    // Clean up ourselves
    await ctrl.shutdown();
  });
});

// ─── CORS ────────────────────────────────────────────────────────────────────

describe("createApi CORS", () => {
  it("includes CORS headers by default", async () => {
    const teamName = `cors-${randomUUID().slice(0, 8)}`;
    const ctrl = new ClaudeCodeController({ teamName, logLevel: "silent" });
    await ctrl.init();
    const app = createApi(ctrl);

    const res = await app.request("/health");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    await ctrl.shutdown();
  });

  it("cors: false disables CORS headers", async () => {
    const teamName = `nocors-${randomUUID().slice(0, 8)}`;
    const ctrl = new ClaudeCodeController({ teamName, logLevel: "silent" });
    await ctrl.init();
    const app = createApi(ctrl, { cors: false });

    const res = await app.request("/health");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();

    await ctrl.shutdown();
  });
});

// ─── logLevel in session/init ────────────────────────────────────────────────

describe("createApi logLevel", () => {
  it("POST /session/init accepts logLevel", async () => {
    const app = createApi();
    const teamName = `log-${randomUUID().slice(0, 8)}`;

    const res = await app.request("/session/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName, logLevel: "silent" }),
    });
    expect(res.status).toBe(201);

    await app.request("/session/shutdown", { method: "POST" });
  });
});
