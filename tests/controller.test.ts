import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const tempBase = mkdtempSync(join(tmpdir(), "cc-ctrl-test-"));

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
const { writeInbox, readInbox } = await import("../src/inbox.js");

describe("ClaudeCodeController", () => {
  let ctrl: InstanceType<typeof ClaudeCodeController>;
  let teamName: string;

  beforeEach(async () => {
    teamName = `test-ctrl-${randomUUID().slice(0, 8)}`;
    ctrl = new ClaudeCodeController({
      teamName,
      logLevel: "silent",
    });
    await ctrl.init();
  });

  afterEach(async () => {
    await ctrl.shutdown();
  });

  it("initializes with a team", async () => {
    const config = await ctrl.team.getConfig();
    expect(config.name).toBe(teamName);
    expect(config.members).toHaveLength(1);
    expect(config.members[0].name).toBe("controller");
  });

  it("supports custom claudeDir", async () => {
    const { _tempBase } = await import("../src/paths.js");
    const claudeDir = join(_tempBase, "alt-claude");

    const team = `dir-${randomUUID().slice(0, 8)}`;
    const ctrl2 = new ClaudeCodeController({
      teamName: team,
      claudeDir,
      logLevel: "silent",
    });
    await ctrl2.init();

    expect(
      existsSync(join(claudeDir, "teams", team, "config.json"))
    ).toBe(true);
    expect(existsSync(join(claudeDir, "tasks", team))).toBe(true);

    await ctrl2.shutdown();
  });

  it("creates tasks", async () => {
    const id = await ctrl.createTask({
      subject: "Test task",
      description: "A test",
    });
    expect(id).toBe("1");

    const task = await ctrl.tasks.get(id);
    expect(task.subject).toBe("Test task");
    expect(task.status).toBe("pending");
  });

  it("creates tasks with owner and sends assignment", async () => {
    const id = await ctrl.createTask({
      subject: "Assigned task",
      description: "Do this",
      owner: "worker1",
    });

    const task = await ctrl.tasks.get(id);
    expect(task.owner).toBe("worker1");

    // Check that the assignment message was written to worker1's inbox
    const inbox = await readInbox(teamName, "worker1");
    expect(inbox).toHaveLength(1);
    const parsed = JSON.parse(inbox[0].text);
    expect(parsed.type).toBe("task_assignment");
    expect(parsed.taskId).toBe(id);
    expect(parsed.subject).toBe("Assigned task");
  });

  it("assigns tasks to agents", async () => {
    const id = await ctrl.createTask({
      subject: "Unassigned",
      description: "Later",
    });

    await ctrl.assignTask(id, "worker2");

    const task = await ctrl.tasks.get(id);
    expect(task.owner).toBe("worker2");

    const inbox = await readInbox(teamName, "worker2");
    expect(inbox).toHaveLength(1);
    const parsed = JSON.parse(inbox[0].text);
    expect(parsed.type).toBe("task_assignment");
    expect(parsed.assignedBy).toBe("controller");
  });

  it("sends messages to agents", async () => {
    await ctrl.send("worker1", "Hello worker", "greeting");

    const inbox = await readInbox(teamName, "worker1");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].text).toBe("Hello worker");
    expect(inbox[0].from).toBe("controller");
    expect(inbox[0].summary).toBe("greeting");
  });

  it("sends shutdown request", async () => {
    await ctrl.sendShutdownRequest("worker1");

    const inbox = await readInbox(teamName, "worker1");
    expect(inbox).toHaveLength(1);
    const parsed = JSON.parse(inbox[0].text);
    expect(parsed.type).toBe("shutdown_request");
    expect(parsed.from).toBe("controller");
    expect(parsed.requestId).toContain("worker1");
  });

  it("sends plan approval", async () => {
    await ctrl.sendPlanApproval("coder", "plan-abc", true, "Looks great");

    const inbox = await readInbox(teamName, "coder");
    expect(inbox).toHaveLength(1);
    const parsed = JSON.parse(inbox[0].text);
    expect(parsed.type).toBe("plan_approval_response");
    expect(parsed.requestId).toBe("plan-abc");
    expect(parsed.approved).toBe(true);
    expect(parsed.feedback).toBe("Looks great");
  });

  it("sends plan rejection", async () => {
    await ctrl.sendPlanApproval("coder", "plan-xyz", false, "Needs rework");

    const inbox = await readInbox(teamName, "coder");
    const parsed = JSON.parse(inbox[0].text);
    expect(parsed.approved).toBe(false);
    expect(parsed.feedback).toBe("Needs rework");
  });

  it("sends permission approval", async () => {
    await ctrl.sendPermissionResponse("worker1", "perm-42", true);

    const inbox = await readInbox(teamName, "worker1");
    const parsed = JSON.parse(inbox[0].text);
    expect(parsed.type).toBe("permission_response");
    expect(parsed.requestId).toBe("perm-42");
    expect(parsed.approved).toBe(true);
  });

  it("sends permission rejection", async () => {
    await ctrl.sendPermissionResponse("worker1", "perm-42", false);

    const inbox = await readInbox(teamName, "worker1");
    const parsed = JSON.parse(inbox[0].text);
    expect(parsed.approved).toBe(false);
  });

  it("broadcasts to all agents", async () => {
    // Add some members to the team config
    await ctrl.team.addMember({
      agentId: `w1@${teamName}`,
      name: "w1",
      agentType: "general-purpose",
      joinedAt: Date.now(),
      cwd: "/tmp",
    });
    await ctrl.team.addMember({
      agentId: `w2@${teamName}`,
      name: "w2",
      agentType: "general-purpose",
      joinedAt: Date.now(),
      cwd: "/tmp",
    });

    await ctrl.broadcast("Everyone listen up", "announcement");

    const inbox1 = await readInbox(teamName, "w1");
    const inbox2 = await readInbox(teamName, "w2");

    expect(inbox1).toHaveLength(1);
    expect(inbox1[0].text).toBe("Everyone listen up");
    expect(inbox1[0].summary).toBe("announcement");

    expect(inbox2).toHaveLength(1);
    expect(inbox2[0].text).toBe("Everyone listen up");
  });

  it("broadcast excludes controller", async () => {
    await ctrl.broadcast("test");

    // Controller's own inbox should not have the broadcast
    const ctrlInbox = await readInbox(teamName, "controller");
    expect(ctrlInbox).toHaveLength(0);
  });

  it("reports claude version", () => {
    const version = ctrl.getClaudeVersion();
    expect(typeof version === "string" || version === null).toBe(true);
  });

  it("verifies compatibility", () => {
    const result = ctrl.verifyCompatibility();
    expect(result).toHaveProperty("compatible");
    expect(result).toHaveProperty("version");
  });

  it("throws if not initialized", async () => {
    const ctrl2 = new ClaudeCodeController({
      teamName: "uninit",
      logLevel: "silent",
    });
    await expect(ctrl2.send("agent", "hello")).rejects.toThrow(
      "not initialized"
    );
  });

  it("can be initialized only once", async () => {
    const same = await ctrl.init();
    expect(same).toBe(ctrl);
  });

  it("isAgentRunning returns false for unknown agents", () => {
    expect(ctrl.isAgentRunning("nonexistent")).toBe(false);
  });
});

describe("ClaudeCodeController events", () => {
  let ctrl: InstanceType<typeof ClaudeCodeController>;
  let teamName: string;

  beforeEach(async () => {
    teamName = `evt-${randomUUID().slice(0, 8)}`;
    ctrl = new ClaudeCodeController({
      teamName,
      logLevel: "silent",
    });
    await ctrl.init();
  });

  afterEach(async () => {
    await ctrl.shutdown();
  });

  it("emits idle event on idle_notification", async () => {
    const idlePromise = new Promise<string>((resolve) => {
      ctrl.on("idle", (agentName: string) => resolve(agentName));
    });

    // Write an idle notification to the controller's inbox
    const idle = JSON.stringify({
      type: "idle_notification",
      from: "worker1",
      timestamp: new Date().toISOString(),
      idleReason: "available",
    });
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: idle,
      timestamp: new Date().toISOString(),
    });

    // Manually trigger a poll cycle
    // @ts-expect-error accessing private
    await ctrl.poller.poll();

    const who = await idlePromise;
    expect(who).toBe("worker1");
  });

  it("emits shutdown:approved event", async () => {
    const approvedPromise = new Promise<{ name: string; msg: any }>(
      (resolve) => {
        ctrl.on("shutdown:approved", (name: string, msg: any) =>
          resolve({ name, msg })
        );
      }
    );

    const msg = JSON.stringify({
      type: "shutdown_approved",
      requestId: "shutdown-123@worker1",
      from: "worker1",
      timestamp: new Date().toISOString(),
      paneId: "pane-1",
      backendType: "tmux",
    });
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: msg,
      timestamp: new Date().toISOString(),
    });

    // @ts-expect-error accessing private
    await ctrl.poller.poll();

    const result = await approvedPromise;
    expect(result.name).toBe("worker1");
    expect(result.msg.requestId).toBe("shutdown-123@worker1");
    expect(result.msg.paneId).toBe("pane-1");
  });

  it("emits plan:approval_request event", async () => {
    const planPromise = new Promise<{ name: string; msg: any }>((resolve) => {
      ctrl.on("plan:approval_request", (name: string, msg: any) =>
        resolve({ name, msg })
      );
    });

    const msg = JSON.stringify({
      type: "plan_approval_request",
      requestId: "plan-789",
      from: "coder",
      planContent: "Step 1: Research\nStep 2: Implement",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(teamName, "controller", {
      from: "coder",
      text: msg,
      timestamp: new Date().toISOString(),
    });

    // @ts-expect-error accessing private
    await ctrl.poller.poll();

    const result = await planPromise;
    expect(result.name).toBe("coder");
    expect(result.msg.requestId).toBe("plan-789");
    expect(result.msg.planContent).toContain("Step 1");
  });

  it("emits permission:request event", async () => {
    const permPromise = new Promise<{ name: string; msg: any }>((resolve) => {
      ctrl.on("permission:request", (name: string, msg: any) =>
        resolve({ name, msg })
      );
    });

    const msg = JSON.stringify({
      type: "permission_request",
      requestId: "perm-456",
      from: "worker1",
      toolName: "Write",
      description: "Write to /tmp/foo.txt",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: msg,
      timestamp: new Date().toISOString(),
    });

    // @ts-expect-error accessing private
    await ctrl.poller.poll();

    const result = await permPromise;
    expect(result.name).toBe("worker1");
    expect(result.msg.toolName).toBe("Write");
    expect(result.msg.description).toBe("Write to /tmp/foo.txt");
  });

  it("emits message event for plain text", async () => {
    const msgPromise = new Promise<{ name: string; msg: any }>((resolve) => {
      ctrl.on("message", (name: string, msg: any) => resolve({ name, msg }));
    });

    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: "Just a plain message",
      timestamp: new Date().toISOString(),
    });

    // @ts-expect-error accessing private
    await ctrl.poller.poll();

    const result = await msgPromise;
    expect(result.name).toBe("worker1");
    expect(result.msg.text).toBe("Just a plain message");
  });
});

describe("ClaudeCodeController receive()", () => {
  let ctrl: InstanceType<typeof ClaudeCodeController>;
  let teamName: string;

  beforeEach(async () => {
    teamName = `recv-${randomUUID().slice(0, 8)}`;
    ctrl = new ClaudeCodeController({
      teamName,
      logLevel: "silent",
    });
    await ctrl.init();
  });

  afterEach(async () => {
    await ctrl.shutdown();
  });

  it("receive returns plain text messages", async () => {
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: "Hello controller",
      timestamp: new Date().toISOString(),
    });

    const messages = await ctrl.receive("worker1", {
      timeout: 1000,
      pollInterval: 50,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("Hello controller");
  });

  it("receive filters out protocol messages", async () => {
    // Write a shutdown_approved (protocol-only)
    const shutdownApproved = JSON.stringify({
      type: "shutdown_approved",
      requestId: "sd-1",
      from: "worker1",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: shutdownApproved,
      timestamp: new Date().toISOString(),
    });

    // Also write a plain text message
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: "Actual content",
      timestamp: new Date().toISOString(),
    });

    const messages = await ctrl.receive("worker1", {
      timeout: 1000,
      pollInterval: 50,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("Actual content");
  });

  it("receive returns idle as fallback when no content messages", async () => {
    const idle = JSON.stringify({
      type: "idle_notification",
      from: "worker1",
      timestamp: new Date().toISOString(),
      idleReason: "turn_ended",
    });
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: idle,
      timestamp: new Date().toISOString(),
    });

    const messages = await ctrl.receive("worker1", {
      timeout: 1000,
      pollInterval: 50,
    });
    expect(messages).toHaveLength(1);
    const parsed = JSON.parse(messages[0].text);
    expect(parsed.type).toBe("idle_notification");
  });

  it("receive times out when no messages", async () => {
    await expect(
      ctrl.receive("worker1", { timeout: 200, pollInterval: 50 })
    ).rejects.toThrow("Timeout");
  });

  it("receive with all option returns all meaningful messages", async () => {
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: "Msg A",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: "Msg B",
      timestamp: new Date().toISOString(),
    });

    const messages = await ctrl.receive("worker1", {
      timeout: 1000,
      pollInterval: 50,
      all: true,
    });
    expect(messages).toHaveLength(2);
  });

  it("receive filters by agent name", async () => {
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: "From worker1",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(teamName, "controller", {
      from: "worker2",
      text: "From worker2",
      timestamp: new Date().toISOString(),
    });

    const messages = await ctrl.receive("worker1", {
      timeout: 1000,
      pollInterval: 50,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe("worker1");
  });

  it("receiveAny returns first message from any agent", async () => {
    await writeInbox(teamName, "controller", {
      from: "worker2",
      text: "Any message",
      timestamp: new Date().toISOString(),
    });

    const msg = await ctrl.receiveAny({
      timeout: 1000,
      pollInterval: 50,
    });
    expect(msg.text).toBe("Any message");
    expect(msg.from).toBe("worker2");
  });

  it("receiveAny times out when no messages", async () => {
    await expect(
      ctrl.receiveAny({ timeout: 200, pollInterval: 50 })
    ).rejects.toThrow("Timeout");
  });

  it("receiveAny skips idle notifications", async () => {
    const idle = JSON.stringify({
      type: "idle_notification",
      from: "worker1",
      timestamp: new Date().toISOString(),
      idleReason: "available",
    });
    await writeInbox(teamName, "controller", {
      from: "worker1",
      text: idle,
      timestamp: new Date().toISOString(),
    });
    await writeInbox(teamName, "controller", {
      from: "worker2",
      text: "Real message",
      timestamp: new Date().toISOString(),
    });

    const msg = await ctrl.receiveAny({
      timeout: 1000,
      pollInterval: 50,
    });
    expect(msg.text).toBe("Real message");
  });
});
