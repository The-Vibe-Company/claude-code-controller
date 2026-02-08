import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const tempBase = mkdtempSync(join(tmpdir(), "cc-swarm-bridge-test-"));

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
  };
});

const { ClaudeCodeController } = await import("../src/controller.js");
const { createSwarmBridgeApi } = await import("../src/api/index.js");
const { writeInbox, readInbox } = await import("../src/inbox.js");

describe("createSwarmBridgeApi", () => {
  let ctrl: InstanceType<typeof ClaudeCodeController>;
  let app: ReturnType<typeof createSwarmBridgeApi>;
  let teamName: string;

  beforeEach(async () => {
    teamName = `swarm-${randomUUID().slice(0, 8)}`;
    // Use a harmless binary so tests don't require the real Claude Code CLI.
    ctrl = new ClaudeCodeController({
      teamName,
      claudeBinary: "true",
      logLevel: "silent",
    });
    await ctrl.init();
    app = createSwarmBridgeApi({ controller: ctrl });
  });

  afterEach(async () => {
    await ctrl.shutdown();
  });

  it("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime_seconds).toBe("number");
  });

  it("POST /agents/:id/ask returns content when controller receives reply", async () => {
    const agentId = `a-${randomUUID().slice(0, 8)}`;

    // Spawn registers the agent and emits agent:spawned (process exits immediately).
    const spawnRes = await app.request("/agents/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId, allowed_tools: ["Read"], model: "sonnet" }),
    });
    expect(spawnRes.status).toBe(201);

    const askPromise = app.request(`/agents/${agentId}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Hello?", timeout_seconds: 2 }),
    });

    // Simulate an agent reply by writing directly to the controller's inbox.
    await new Promise((r) => setTimeout(r, 10));
    await writeInbox(teamName, "controller", {
      from: agentId,
      text: "Hi from agent",
      timestamp: new Date().toISOString(),
    });

    const askRes = await askPromise;
    expect(askRes.status).toBe(200);
    const body = await askRes.json();
    expect(body.content).toContain("Hi from agent");
    expect(body.tool_calls).toEqual([]);
  });

  it("POST /governance/respond routes plan approvals to the correct agent inbox", async () => {
    const agentId = `g-${randomUUID().slice(0, 8)}`;
    await app.request("/agents/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId }),
    });

    const requestId = `plan-${randomUUID().slice(0, 8)}`;
    await writeInbox(teamName, "controller", {
      from: agentId,
      text: JSON.stringify({
        type: "plan_approval_request",
        requestId,
        from: agentId,
        planContent: "Step 1: ...",
        timestamp: new Date().toISOString(),
      }),
      timestamp: new Date().toISOString(),
    });

    // Force one poll cycle to emit controller events
    // @ts-expect-error access private for testing
    await ctrl.poller.poll();

    const govRes = await app.request("/governance/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        decision: "approve",
        reason: "ok",
      }),
    });
    expect(govRes.status).toBe(200);

    const inbox = await readInbox(teamName, agentId);
    expect(inbox.length).toBeGreaterThan(0);
    const parsed = JSON.parse(inbox[inbox.length - 1].text);
    expect(parsed.type).toBe("plan_approval_response");
    expect(parsed.requestId).toBe(requestId);
    expect(parsed.approved).toBe(true);
    expect(parsed.feedback).toBe("ok");
  });

  it("enforces optional Bearer auth", async () => {
    const secured = createSwarmBridgeApi({ controller: ctrl, apiKey: "secret" });
    const unauth = await secured.request("/events");
    expect(unauth.status).toBe(401);

    const ok = await secured.request("/events", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(ok.status).toBe(200);
  });
});

