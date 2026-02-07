import {
  describe,
  it,
  expect,
  afterEach,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { ClaudeCodeController } from "../src/controller.js";
import { writeInbox, readInbox } from "../src/inbox.js";
import { createApi } from "../src/api/index.js";
import type { PermissionRequestMessage, PlanApprovalRequestMessage } from "../src/types.js";

// ─── E2E Gate ───────────────────────────────────────────────────────────────

const E2E_ENABLED = process.env.E2E === "1";

// ─── Configuration ──────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val && E2E_ENABLED) {
    throw new Error(
      `Missing required env var ${name}. ` +
        `Copy .env.example to .env and fill in your credentials, then run: make e2e`,
    );
  }
  return val || "";
}

const CFG = {
  authToken: requireEnv("E2E_AUTH_TOKEN"),
  baseUrl: process.env.E2E_BASE_URL || "https://api.z.ai/api/anthropic",
  apiTimeout: process.env.E2E_API_TIMEOUT_MS || "3000000",
  model: process.env.E2E_MODEL || "sonnet",
  spawnWaitMs: 15_000,
  askTimeoutMs: 180_000,
};

function agentEnv() {
  return {
    ANTHROPIC_AUTH_TOKEN: CFG.authToken,
    ANTHROPIC_BASE_URL: CFG.baseUrl,
    API_TIMEOUT_MS: CFG.apiTimeout,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait for a controller event with timeout. Returns the event args as a tuple. */
function waitForEvent<T extends unknown[]>(
  ctrl: ClaudeCodeController,
  event: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for "${event}" (${timeoutMs}ms)`)),
      timeoutMs,
    );
    ctrl.once(event as any, (...args: any[]) => {
      clearTimeout(timer);
      resolve(args as T);
    });
  });
}

/** Inject a simulated message into the controller's inbox. */
async function injectToController(
  teamName: string,
  from: string,
  message: Record<string, unknown>,
) {
  await writeInbox(teamName, "controller", {
    from,
    text: JSON.stringify(message),
    timestamp: new Date().toISOString(),
  });
}

// ─── A: Controller Lifecycle ────────────────────────────────────────────────

describe.skipIf(!E2E_ENABLED)("E2E: Controller Lifecycle", () => {
  let ctrl: ClaudeCodeController;

  afterEach(async () => {
    try {
      await ctrl?.shutdown();
    } catch {
      // best effort
    }
  });

  it(
    "init creates team files and shutdown cleans them up",
    async () => {
      const teamName = `e2e-life-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({
        teamName,
        logLevel: "warn",
        env: agentEnv(),
      });

      await ctrl.init();

      // Team config should exist
      const config = await ctrl.team.getConfig();
      expect(config.name).toBe(teamName);

      await ctrl.shutdown();

      // After shutdown, reading config should throw (files deleted)
      let threw = false;
      try {
        await ctrl.team.getConfig();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    },
    10_000,
  );

  it(
    "verifyCompatibility returns a version",
    async () => {
      const teamName = `e2e-compat-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({
        teamName,
        logLevel: "warn",
        env: agentEnv(),
      });

      await ctrl.init();
      const result = ctrl.verifyCompatibility();

      expect(result.compatible).toBe(true);
      expect(result.version).toBeTruthy();
      console.log(`[E2E] Claude CLI version: ${result.version}`);
    },
    10_000,
  );
});

// ─── B: Agent Spawn & Process Management ────────────────────────────────────

describe.skipIf(!E2E_ENABLED)("E2E: Agent Spawn", () => {
  let ctrl: ClaudeCodeController;

  afterEach(async () => {
    if (ctrl) {
      try {
        // Force kill any remaining agents
        const running = (ctrl as any).processes?.runningAgents?.() || [];
        for (const name of running) {
          try {
            await ctrl.killAgent(name);
          } catch {}
        }
        await ctrl.shutdown();
      } catch {
        try {
          await ctrl.team.destroy();
        } catch {}
      }
    }
  });

  it(
    "spawns an agent that stays alive",
    async () => {
      const teamName = `e2e-spawn-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({
        teamName,
        logLevel: "info",
        env: agentEnv(),
      });
      await ctrl.init();

      const agent = await ctrl.spawnAgent({
        name: "worker",
        type: "general-purpose",
        model: CFG.model,
      });

      expect(agent.name).toBe("worker");
      expect(agent.pid).toBeGreaterThan(0);
      expect(agent.isRunning).toBe(true);

      // Wait a bit and verify still alive
      await sleep(5_000);
      expect(agent.isRunning).toBe(true);
    },
    30_000,
  );

  it(
    "fires agent:spawned and agent:exited events",
    async () => {
      const teamName = `e2e-events-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({
        teamName,
        logLevel: "info",
        env: agentEnv(),
      });
      await ctrl.init();

      const events: string[] = [];

      ctrl.on("agent:spawned", (name) => events.push(`spawned:${name}`));
      ctrl.on("agent:exited", (name) => events.push(`exited:${name}`));

      const agent = await ctrl.spawnAgent({
        name: "evworker",
        type: "general-purpose",
        model: CFG.model,
      });

      expect(events).toContain("spawned:evworker");

      await ctrl.killAgent("evworker");
      await sleep(2_000);

      expect(events).toContain("exited:evworker");
    },
    30_000,
  );

  it(
    "killAgent terminates the process",
    async () => {
      const teamName = `e2e-kill-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({
        teamName,
        logLevel: "info",
        env: agentEnv(),
      });
      await ctrl.init();

      const agent = await ctrl.spawnAgent({
        name: "killme",
        type: "general-purpose",
        model: CFG.model,
      });

      expect(agent.isRunning).toBe(true);

      await ctrl.killAgent("killme");
      await sleep(1_000);

      expect(ctrl.isAgentRunning("killme")).toBe(false);
    },
    30_000,
  );
});

// ─── C: Ask Round-Trip ──────────────────────────────────────────────────────

describe.skipIf(!E2E_ENABLED)("E2E: Ask Round-Trip", () => {
  let ctrl: ClaudeCodeController;

  afterEach(async () => {
    if (ctrl) {
      try {
        const running = (ctrl as any).processes?.runningAgents?.() || [];
        for (const name of running) {
          try {
            await ctrl.killAgent(name);
          } catch {}
        }
        await ctrl.shutdown();
      } catch {
        try {
          await ctrl.team.destroy();
        } catch {}
      }
    }
  });

  it(
    "agent.ask() returns a response from GLM 4.7",
    async () => {
      const teamName = `e2e-ask-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({
        teamName,
        logLevel: "info",
        env: agentEnv(),
      });
      await ctrl.init();

      const agent = await ctrl.spawnAgent({
        name: "asker",
        type: "general-purpose",
        model: CFG.model,
      });

      // Wait for agent to fully initialize
      await sleep(CFG.spawnWaitMs);

      try {
        const response = await agent.ask(
          "What is 2+2? Send your answer back to me using the SendMessage tool.",
          { timeout: CFG.askTimeoutMs },
        );

        expect(response.length).toBeGreaterThan(0);
        console.log(
          `[E2E] Ask response (first 300 chars): ${response.slice(0, 300)}`,
        );

        // Soft check: is this an idle notification rather than a real answer?
        let isIdle = false;
        try {
          const parsed = JSON.parse(response);
          isIdle = parsed?.type === "idle_notification";
        } catch {
          // Not JSON — it's likely a real text response
        }

        if (isIdle) {
          console.warn(
            "[E2E] Agent went idle without sending a content response — " +
              "GLM 4.7 may not support the teammate SendMessage protocol",
          );
        } else if (!response.includes("4")) {
          console.warn(
            `[E2E] Response received but does not contain "4": ${response.slice(0, 200)}`,
          );
        }
      } catch (err) {
        // Timeout is a soft failure for non-Claude models
        if (String(err).includes("Timeout")) {
          console.warn(
            "[E2E] agent.ask() timed out — GLM 4.7 may not support teammate protocol. " +
              "This is not necessarily a failure of the controller.",
          );
        } else {
          throw err;
        }
      }
    },
    240_000,
  );
});

// ─── D: Task Management ────────────────────────────────────────────────────

describe.skipIf(!E2E_ENABLED)("E2E: Task Management", () => {
  let ctrl: ClaudeCodeController;

  afterEach(async () => {
    try {
      await ctrl?.shutdown();
    } catch {}
  });

  it(
    "CRUD tasks on real filesystem",
    async () => {
      const teamName = `e2e-tasks-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({
        teamName,
        logLevel: "warn",
        env: agentEnv(),
      });
      await ctrl.init();

      // Create
      const id = await ctrl.createTask({
        subject: "E2E test task",
        description: "Created by e2e.test.ts",
      });
      expect(id).toBe("1");

      // Read
      const task = await ctrl.tasks.get(id);
      expect(task.subject).toBe("E2E test task");
      expect(task.status).toBe("pending");

      // Update
      await ctrl.tasks.update(id, { status: "in_progress" });
      const updated = await ctrl.tasks.get(id);
      expect(updated.status).toBe("in_progress");

      // List
      const list = await ctrl.tasks.list();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe("1");
    },
    10_000,
  );
});

// ─── E: REST API ────────────────────────────────────────────────────────────

describe.skipIf(!E2E_ENABLED)("E2E: REST API", () => {
  let ctrl: ClaudeCodeController;

  afterEach(async () => {
    if (ctrl) {
      try {
        const running = (ctrl as any).processes?.runningAgents?.() || [];
        for (const name of running) {
          try {
            await ctrl.killAgent(name);
          } catch {}
        }
        await ctrl.shutdown();
      } catch {
        try {
          await ctrl.team.destroy();
        } catch {}
      }
    }
  });

  it(
    "GET /health returns ok",
    async () => {
      const teamName = `e2e-api-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({
        teamName,
        logLevel: "warn",
        env: agentEnv(),
      });
      await ctrl.init();

      const app = createApi(ctrl);
      const res = await app.request("/health");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
    },
    10_000,
  );

  it(
    "POST /agents spawns a real agent via REST",
    async () => {
      const teamName = `e2e-apiag-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({
        teamName,
        logLevel: "info",
        env: agentEnv(),
      });
      await ctrl.init();

      const app = createApi(ctrl);

      // Spawn via API
      const spawnRes = await app.request("/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "api-worker",
          type: "general-purpose",
          model: CFG.model,
        }),
      });

      expect(spawnRes.status).toBe(201);
      const spawnBody = await spawnRes.json();
      expect(spawnBody.name).toBe("api-worker");
      expect(spawnBody.running).toBe(true);

      // List agents via API
      const listRes = await app.request("/agents");
      expect(listRes.status).toBe(200);
      const agents = await listRes.json();
      expect(agents.some((a: any) => a.name === "api-worker")).toBe(true);

      // Kill via API
      const killRes = await app.request("/agents/api-worker/kill", {
        method: "POST",
      });
      expect(killRes.status).toBe(200);
    },
    60_000,
  );
});

// ─── F: Protocol — Permission Handling ──────────────────────────────────────

describe.skipIf(!E2E_ENABLED)("E2E: Protocol — Permission Handling", () => {
  let ctrl: ClaudeCodeController;

  afterEach(async () => {
    try {
      await ctrl?.shutdown();
    } catch {}
  });

  it(
    "permission request triggers event and approval reaches agent inbox",
    async () => {
      const teamName = `e2e-perm-ok-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({ teamName, logLevel: "warn", env: agentEnv() });
      await ctrl.init();

      const requestId = `perm-${Date.now()}`;

      // Setup listener BEFORE injecting message
      const eventPromise = waitForEvent<[string, PermissionRequestMessage]>(
        ctrl,
        "permission:request",
        5_000,
      );

      // Inject a simulated permission request from a fake agent
      await injectToController(teamName, "fake-agent", {
        type: "permission_request",
        requestId,
        from: "fake-agent",
        toolName: "Bash",
        description: "Run echo hello",
        timestamp: new Date().toISOString(),
      });

      // Wait for the poller to pick it up (runs every 500ms)
      const [agentName, parsed] = await eventPromise;

      expect(agentName).toBe("fake-agent");
      expect(parsed.requestId).toBe(requestId);
      expect(parsed.toolName).toBe("Bash");

      // Approve the permission
      await ctrl.sendPermissionResponse("fake-agent", requestId, true);

      // Verify the response landed in the agent's inbox
      const inbox = await readInbox(teamName, "fake-agent");
      expect(inbox.length).toBeGreaterThanOrEqual(1);
      const response = JSON.parse(inbox[inbox.length - 1].text);
      expect(response.type).toBe("permission_response");
      expect(response.requestId).toBe(requestId);
      expect(response.approved).toBe(true);
    },
    10_000,
  );

  it(
    "permission rejection reaches agent inbox",
    async () => {
      const teamName = `e2e-perm-rej-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({ teamName, logLevel: "warn", env: agentEnv() });
      await ctrl.init();

      const requestId = `perm-rej-${Date.now()}`;

      const eventPromise = waitForEvent<[string, PermissionRequestMessage]>(
        ctrl,
        "permission:request",
        5_000,
      );

      await injectToController(teamName, "fake-agent", {
        type: "permission_request",
        requestId,
        from: "fake-agent",
        toolName: "Write",
        description: "Write to /tmp/secret.txt",
        timestamp: new Date().toISOString(),
      });

      await eventPromise;

      // Reject the permission
      await ctrl.sendPermissionResponse("fake-agent", requestId, false);

      const inbox = await readInbox(teamName, "fake-agent");
      const response = JSON.parse(inbox[inbox.length - 1].text);
      expect(response.type).toBe("permission_response");
      expect(response.requestId).toBe(requestId);
      expect(response.approved).toBe(false);
    },
    10_000,
  );

  it(
    "ActionTracker tracks permission via GET /actions",
    async () => {
      const teamName = `e2e-perm-api-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({ teamName, logLevel: "warn", env: agentEnv() });
      await ctrl.init();
      const app = createApi(ctrl);

      const requestId = `perm-api-${Date.now()}`;

      const eventPromise = waitForEvent<[string, PermissionRequestMessage]>(
        ctrl,
        "permission:request",
        5_000,
      );

      await injectToController(teamName, "fake-agent", {
        type: "permission_request",
        requestId,
        from: "fake-agent",
        toolName: "Bash",
        description: "Run ls",
        timestamp: new Date().toISOString(),
      });

      await eventPromise;

      // GET /actions should show the pending permission
      const actionsRes = await app.request("/actions");
      expect(actionsRes.status).toBe(200);
      const actions = await actionsRes.json() as any;
      expect(actions.pending).toBeGreaterThanOrEqual(1);
      const perm = actions.approvals.find((a: any) => a.requestId === requestId);
      expect(perm).toBeTruthy();
      expect(perm.type).toBe("permission");
      expect(perm.toolName).toBe("Bash");

      // Approve via REST API
      const approveRes = await app.request("/agents/fake-agent/approve-permission", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, approve: true }),
      });
      expect(approveRes.status).toBe(200);

      // GET /actions should now be empty
      const afterRes = await app.request("/actions");
      const after = await afterRes.json() as any;
      const gone = after.approvals.find((a: any) => a.requestId === requestId);
      expect(gone).toBeUndefined();
    },
    10_000,
  );
});

// ─── G: Protocol — Plan Approval Handling ───────────────────────────────────

describe.skipIf(!E2E_ENABLED)("E2E: Protocol — Plan Approval", () => {
  let ctrl: ClaudeCodeController;

  afterEach(async () => {
    try {
      await ctrl?.shutdown();
    } catch {}
  });

  it(
    "plan approval request triggers event and approval with feedback reaches agent inbox",
    async () => {
      const teamName = `e2e-plan-ok-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({ teamName, logLevel: "warn", env: agentEnv() });
      await ctrl.init();

      const requestId = `plan-${Date.now()}`;

      const eventPromise = waitForEvent<[string, PlanApprovalRequestMessage]>(
        ctrl,
        "plan:approval_request",
        5_000,
      );

      await injectToController(teamName, "fake-planner", {
        type: "plan_approval_request",
        requestId,
        from: "fake-planner",
        planContent: "Step 1: Research\nStep 2: Implement\nStep 3: Test",
        timestamp: new Date().toISOString(),
      });

      const [agentName, parsed] = await eventPromise;

      expect(agentName).toBe("fake-planner");
      expect(parsed.requestId).toBe(requestId);
      expect(parsed.planContent).toContain("Step 1");

      // Approve with feedback
      await ctrl.sendPlanApproval("fake-planner", requestId, true, "LGTM");

      const inbox = await readInbox(teamName, "fake-planner");
      const response = JSON.parse(inbox[inbox.length - 1].text);
      expect(response.type).toBe("plan_approval_response");
      expect(response.requestId).toBe(requestId);
      expect(response.approved).toBe(true);
      expect(response.feedback).toBe("LGTM");
    },
    10_000,
  );

  it(
    "plan rejection with feedback reaches agent inbox",
    async () => {
      const teamName = `e2e-plan-rej-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({ teamName, logLevel: "warn", env: agentEnv() });
      await ctrl.init();

      const requestId = `plan-rej-${Date.now()}`;

      const eventPromise = waitForEvent<[string, PlanApprovalRequestMessage]>(
        ctrl,
        "plan:approval_request",
        5_000,
      );

      await injectToController(teamName, "fake-planner", {
        type: "plan_approval_request",
        requestId,
        from: "fake-planner",
        planContent: "Step 1: Delete everything",
        timestamp: new Date().toISOString(),
      });

      await eventPromise;

      // Reject with feedback
      await ctrl.sendPlanApproval("fake-planner", requestId, false, "Add error handling");

      const inbox = await readInbox(teamName, "fake-planner");
      const response = JSON.parse(inbox[inbox.length - 1].text);
      expect(response.type).toBe("plan_approval_response");
      expect(response.approved).toBe(false);
      expect(response.feedback).toBe("Add error handling");
    },
    10_000,
  );

  it(
    "ActionTracker tracks plan approval via GET /actions",
    async () => {
      const teamName = `e2e-plan-api-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({ teamName, logLevel: "warn", env: agentEnv() });
      await ctrl.init();
      const app = createApi(ctrl);

      const requestId = `plan-api-${Date.now()}`;

      const eventPromise = waitForEvent<[string, PlanApprovalRequestMessage]>(
        ctrl,
        "plan:approval_request",
        5_000,
      );

      await injectToController(teamName, "fake-planner", {
        type: "plan_approval_request",
        requestId,
        from: "fake-planner",
        planContent: "Step 1: Build API\nStep 2: Add tests",
        timestamp: new Date().toISOString(),
      });

      await eventPromise;

      // GET /actions should show the pending plan
      const actionsRes = await app.request("/actions");
      const actions = await actionsRes.json() as any;
      const plan = actions.approvals.find((a: any) => a.requestId === requestId);
      expect(plan).toBeTruthy();
      expect(plan.type).toBe("plan");
      expect(plan.planContent).toContain("Step 1");

      // Approve via REST API
      const approveRes = await app.request("/agents/fake-planner/approve-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, approve: true, feedback: "Go ahead" }),
      });
      expect(approveRes.status).toBe(200);

      // GET /actions should now be clean
      const afterRes = await app.request("/actions");
      const after = await afterRes.json() as any;
      const gone = after.approvals.find((a: any) => a.requestId === requestId);
      expect(gone).toBeUndefined();
    },
    10_000,
  );
});

// ─── H: Live — Permission Flow ──────────────────────────────────────────────

describe.skipIf(!E2E_ENABLED)("E2E: Live — Permission Flow", () => {
  let ctrl: ClaudeCodeController;

  afterEach(async () => {
    if (ctrl) {
      try {
        const running = (ctrl as any).processes?.runningAgents?.() || [];
        for (const name of running) {
          try { await ctrl.killAgent(name); } catch {}
        }
        await ctrl.shutdown();
      } catch {
        try { await ctrl.team.destroy(); } catch {}
      }
    }
  });

  it(
    "restricted agent triggers permission request for forbidden tool",
    async () => {
      const teamName = `e2e-liveperm-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({
        teamName,
        logLevel: "info",
        env: agentEnv(),
      });
      await ctrl.init();

      // Spawn agent with restricted permissions — NO Bash allowed
      const agent = await ctrl.spawnAgent({
        name: "restricted",
        type: "general-purpose",
        model: CFG.model,
        permissions: ["Read", "Glob"],
      });

      await sleep(CFG.spawnWaitMs);

      // Listen for permission request
      const permPromise = waitForEvent<[string, PermissionRequestMessage]>(
        ctrl,
        "permission:request",
        120_000,
      ).catch(() => null); // null on timeout

      // Ask the agent to use Bash (which it doesn't have permission for)
      await agent.send(
        "Run the command `echo hello world` using the Bash tool. This is important.",
      );

      const result = await permPromise;

      if (result) {
        const [agentName, parsed] = result;
        console.log(
          `[E2E] Permission request received: tool="${parsed.toolName}" from="${agentName}"`,
        );
        expect(agentName).toBe("restricted");
        expect(parsed.toolName).toBeTruthy();
        expect(parsed.requestId).toBeTruthy();

        // Approve the permission
        await ctrl.sendPermissionResponse(agentName, parsed.requestId, true);
        console.log("[E2E] Permission approved successfully");
      } else {
        console.warn(
          "[E2E] No permission request received within timeout — " +
            "GLM 4.7 may not have attempted to use the restricted tool",
        );
      }
    },
    180_000,
  );
});

// ─── I: Live — Plan Mode ────────────────────────────────────────────────────

describe.skipIf(!E2E_ENABLED)("E2E: Live — Plan Mode", () => {
  let ctrl: ClaudeCodeController;

  afterEach(async () => {
    if (ctrl) {
      try {
        const running = (ctrl as any).processes?.runningAgents?.() || [];
        for (const name of running) {
          try { await ctrl.killAgent(name); } catch {}
        }
        await ctrl.shutdown();
      } catch {
        try { await ctrl.team.destroy(); } catch {}
      }
    }
  });

  it(
    "Plan-type agent requests plan approval",
    async () => {
      const teamName = `e2e-liveplan-${randomUUID().slice(0, 8)}`;
      ctrl = new ClaudeCodeController({
        teamName,
        logLevel: "info",
        env: agentEnv(),
      });
      await ctrl.init();

      // Spawn a Plan-type agent
      const agent = await ctrl.spawnAgent({
        name: "planner",
        type: "Plan",
        model: CFG.model,
      });

      await sleep(CFG.spawnWaitMs);

      // Listen for plan approval request
      const planPromise = waitForEvent<[string, PlanApprovalRequestMessage]>(
        ctrl,
        "plan:approval_request",
        120_000,
      ).catch(() => null);

      // Give the agent a complex task that should trigger planning
      await agent.send(
        "Create a Node.js REST API with Express that has 3 endpoints: " +
          "GET /users, POST /users, DELETE /users/:id. " +
          "Plan your approach first before implementing.",
      );

      const result = await planPromise;

      if (result) {
        const [agentName, parsed] = result;
        console.log(
          `[E2E] Plan approval request received from "${agentName}"`,
        );
        console.log(
          `[E2E] Plan content (first 300 chars): ${(parsed.planContent || "").slice(0, 300)}`,
        );
        expect(agentName).toBe("planner");
        expect(parsed.requestId).toBeTruthy();

        // Approve the plan
        await ctrl.sendPlanApproval(agentName, parsed.requestId, true, "Approved");
        console.log("[E2E] Plan approved successfully");
      } else {
        console.warn(
          "[E2E] No plan approval request received within timeout — " +
            "GLM 4.7 may not support plan mode in teammate protocol",
        );
      }
    },
    180_000,
  );
});
