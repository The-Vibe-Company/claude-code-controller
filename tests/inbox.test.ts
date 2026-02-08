import { describe, it, expect, beforeEach, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { InboxMessage } from "../src/types.js";

const tempBase = mkdtempSync(join(tmpdir(), "cc-inbox-test-"));

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

const { writeInbox, readInbox, readUnread, parseMessage } = await import(
  "../src/inbox.js"
);

describe("parseMessage", () => {
  it("parses plain text messages", () => {
    const msg: InboxMessage = {
      from: "agent1",
      text: "Hello world",
      timestamp: new Date().toISOString(),
      read: false,
    };
    const parsed = parseMessage(msg);
    expect(parsed.type).toBe("plain_text");
    expect(parsed).toEqual({ type: "plain_text", text: "Hello world" });
  });

  it("parses task assignment messages", () => {
    const inner = {
      type: "task_assignment",
      taskId: "1",
      subject: "Do something",
      description: "Details here",
      assignedBy: "controller",
      timestamp: new Date().toISOString(),
    };
    const msg: InboxMessage = {
      from: "controller",
      text: JSON.stringify(inner),
      timestamp: new Date().toISOString(),
      read: false,
    };
    const parsed = parseMessage(msg);
    expect(parsed.type).toBe("task_assignment");
    if (parsed.type === "task_assignment") {
      expect(parsed.taskId).toBe("1");
      expect(parsed.subject).toBe("Do something");
      expect(parsed.description).toBe("Details here");
      expect(parsed.assignedBy).toBe("controller");
    }
  });

  it("parses shutdown request messages", () => {
    const inner = {
      type: "shutdown_request",
      requestId: "shutdown-123@agent1",
      from: "controller",
      reason: "Done",
      timestamp: new Date().toISOString(),
    };
    const msg: InboxMessage = {
      from: "controller",
      text: JSON.stringify(inner),
      timestamp: new Date().toISOString(),
      read: false,
    };
    const parsed = parseMessage(msg);
    expect(parsed.type).toBe("shutdown_request");
    if (parsed.type === "shutdown_request") {
      expect(parsed.requestId).toBe("shutdown-123@agent1");
      expect(parsed.reason).toBe("Done");
    }
  });

  it("parses shutdown_approved messages", () => {
    const inner = {
      type: "shutdown_approved",
      requestId: "shutdown-123@worker",
      from: "worker",
      timestamp: new Date().toISOString(),
      paneId: "in-process",
      backendType: "in-process",
    };
    const msg: InboxMessage = {
      from: "worker",
      text: JSON.stringify(inner),
      timestamp: new Date().toISOString(),
      read: false,
    };
    const parsed = parseMessage(msg);
    expect(parsed.type).toBe("shutdown_approved");
    if (parsed.type === "shutdown_approved") {
      expect(parsed.paneId).toBe("in-process");
      expect(parsed.backendType).toBe("in-process");
      expect(parsed.requestId).toBe("shutdown-123@worker");
    }
  });

  it("parses idle notification messages", () => {
    const inner = {
      type: "idle_notification",
      from: "agent1",
      timestamp: new Date().toISOString(),
      idleReason: "available",
    };
    const msg: InboxMessage = {
      from: "agent1",
      text: JSON.stringify(inner),
      timestamp: new Date().toISOString(),
      read: false,
    };
    const parsed = parseMessage(msg);
    expect(parsed.type).toBe("idle_notification");
    if (parsed.type === "idle_notification") {
      expect(parsed.idleReason).toBe("available");
    }
  });

  it("parses plan_approval_request messages", () => {
    const inner = {
      type: "plan_approval_request",
      requestId: "plan-123",
      from: "coder",
      planContent: "Step 1: ...",
      timestamp: new Date().toISOString(),
    };
    const msg: InboxMessage = {
      from: "coder",
      text: JSON.stringify(inner),
      timestamp: new Date().toISOString(),
      read: false,
    };
    const parsed = parseMessage(msg);
    expect(parsed.type).toBe("plan_approval_request");
    if (parsed.type === "plan_approval_request") {
      expect(parsed.planContent).toBe("Step 1: ...");
      expect(parsed.requestId).toBe("plan-123");
    }
  });

  it("parses plan_approval_response messages", () => {
    const inner = {
      type: "plan_approval_response",
      requestId: "plan-123",
      from: "controller",
      approved: true,
      feedback: "Looks good",
      timestamp: new Date().toISOString(),
    };
    const msg: InboxMessage = {
      from: "controller",
      text: JSON.stringify(inner),
      timestamp: new Date().toISOString(),
      read: false,
    };
    const parsed = parseMessage(msg);
    expect(parsed.type).toBe("plan_approval_response");
    if (parsed.type === "plan_approval_response") {
      expect(parsed.approved).toBe(true);
      expect(parsed.feedback).toBe("Looks good");
    }
  });

  it("parses permission_request messages", () => {
    const inner = {
      type: "permission_request",
      requestId: "perm-123",
      from: "worker",
      toolName: "Bash",
      description: "Run git status",
      timestamp: new Date().toISOString(),
    };
    const msg: InboxMessage = {
      from: "worker",
      text: JSON.stringify(inner),
      timestamp: new Date().toISOString(),
      read: false,
    };
    const parsed = parseMessage(msg);
    expect(parsed.type).toBe("permission_request");
    if (parsed.type === "permission_request") {
      expect(parsed.toolName).toBe("Bash");
      expect(parsed.description).toBe("Run git status");
    }
  });

  it("parses permission_response messages", () => {
    const inner = {
      type: "permission_response",
      requestId: "perm-123",
      from: "controller",
      approved: false,
      timestamp: new Date().toISOString(),
    };
    const msg: InboxMessage = {
      from: "controller",
      text: JSON.stringify(inner),
      timestamp: new Date().toISOString(),
      read: false,
    };
    const parsed = parseMessage(msg);
    expect(parsed.type).toBe("permission_response");
    if (parsed.type === "permission_response") {
      expect(parsed.approved).toBe(false);
    }
  });

  it("handles invalid JSON gracefully", () => {
    const msg: InboxMessage = {
      from: "agent1",
      text: "not { valid json",
      timestamp: new Date().toISOString(),
      read: false,
    };
    const parsed = parseMessage(msg);
    expect(parsed.type).toBe("plain_text");
    if (parsed.type === "plain_text") {
      expect(parsed.text).toBe("not { valid json");
    }
  });

  it("handles JSON without type field as plain text", () => {
    const msg: InboxMessage = {
      from: "agent1",
      text: '{"foo": "bar"}',
      timestamp: new Date().toISOString(),
      read: false,
    };
    const parsed = parseMessage(msg);
    expect(parsed.type).toBe("plain_text");
  });

  it("handles empty string as plain text", () => {
    const msg: InboxMessage = {
      from: "agent1",
      text: "",
      timestamp: new Date().toISOString(),
      read: false,
    };
    const parsed = parseMessage(msg);
    expect(parsed.type).toBe("plain_text");
    if (parsed.type === "plain_text") {
      expect(parsed.text).toBe("");
    }
  });

  it("handles JSON array as plain text", () => {
    const msg: InboxMessage = {
      from: "agent1",
      text: "[1, 2, 3]",
      timestamp: new Date().toISOString(),
      read: false,
    };
    const parsed = parseMessage(msg);
    expect(parsed.type).toBe("plain_text");
  });

  it("handles JSON with unknown type as structured", () => {
    const inner = {
      type: "unknown_type",
      data: "something",
    };
    const msg: InboxMessage = {
      from: "agent1",
      text: JSON.stringify(inner),
      timestamp: new Date().toISOString(),
      read: false,
    };
    const parsed = parseMessage(msg);
    expect((parsed as any).type).toBe("unknown_type");
  });
});

describe("writeInbox / readInbox / readUnread", () => {
  let team: string;

  beforeEach(() => {
    team = `test-${randomUUID().slice(0, 8)}`;
  });

  it("writes and reads messages", async () => {
    await writeInbox(team, "agent1", {
      from: "controller",
      text: "Hello",
      timestamp: new Date().toISOString(),
    });

    const messages = await readInbox(team, "agent1");
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("Hello");
    expect(messages[0].from).toBe("controller");
    expect(messages[0].read).toBe(false);
  });

  it("appends messages to existing inbox", async () => {
    await writeInbox(team, "agent1", {
      from: "controller",
      text: "First",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(team, "agent1", {
      from: "controller",
      text: "Second",
      timestamp: new Date().toISOString(),
    });

    const messages = await readInbox(team, "agent1");
    expect(messages).toHaveLength(2);
    expect(messages[0].text).toBe("First");
    expect(messages[1].text).toBe("Second");
  });

  it("readUnread marks messages as read", async () => {
    await writeInbox(team, "agent1", {
      from: "controller",
      text: "Msg 1",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(team, "agent1", {
      from: "controller",
      text: "Msg 2",
      timestamp: new Date().toISOString(),
    });

    const unread = await readUnread(team, "agent1");
    expect(unread).toHaveLength(2);

    const unread2 = await readUnread(team, "agent1");
    expect(unread2).toHaveLength(0);

    const all = await readInbox(team, "agent1");
    expect(all).toHaveLength(2);
    expect(all[0].read).toBe(true);
    expect(all[1].read).toBe(true);
  });

  it("returns empty for non-existent inbox", async () => {
    const messages = await readInbox(team, "nonexistent");
    expect(messages).toEqual([]);
  });

  it("readUnread returns empty for non-existent inbox", async () => {
    const messages = await readUnread(team, "nonexistent");
    expect(messages).toEqual([]);
  });

  it("handles concurrent writes correctly", async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        writeInbox(team, "agent1", {
          from: "controller",
          text: `Message ${i}`,
          timestamp: new Date().toISOString(),
        })
      )
    );

    const messages = await readInbox(team, "agent1");
    expect(messages).toHaveLength(5);
  });

  it("preserves summary and color fields", async () => {
    await writeInbox(team, "agent1", {
      from: "worker",
      text: "Status update",
      timestamp: new Date().toISOString(),
      summary: "Quick status",
      color: "blue",
    });

    const messages = await readInbox(team, "agent1");
    expect(messages[0].summary).toBe("Quick status");
    expect(messages[0].color).toBe("blue");
  });

  it("separates inboxes per agent", async () => {
    await writeInbox(team, "agent1", {
      from: "controller",
      text: "For agent1",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(team, "agent2", {
      from: "controller",
      text: "For agent2",
      timestamp: new Date().toISOString(),
    });

    const msgs1 = await readInbox(team, "agent1");
    const msgs2 = await readInbox(team, "agent2");
    expect(msgs1).toHaveLength(1);
    expect(msgs1[0].text).toBe("For agent1");
    expect(msgs2).toHaveLength(1);
    expect(msgs2[0].text).toBe("For agent2");
  });

  it("readUnread only returns new messages after read", async () => {
    await writeInbox(team, "agent1", {
      from: "controller",
      text: "First batch",
      timestamp: new Date().toISOString(),
    });

    const batch1 = await readUnread(team, "agent1");
    expect(batch1).toHaveLength(1);

    await writeInbox(team, "agent1", {
      from: "controller",
      text: "Second batch",
      timestamp: new Date().toISOString(),
    });

    const batch2 = await readUnread(team, "agent1");
    expect(batch2).toHaveLength(1);
    expect(batch2[0].text).toBe("Second batch");
  });

  it("preserves timestamps", async () => {
    const ts = "2024-01-15T10:30:00.000Z";
    await writeInbox(team, "agent1", {
      from: "controller",
      text: "Timestamped",
      timestamp: ts,
    });

    const messages = await readInbox(team, "agent1");
    expect(messages[0].timestamp).toBe(ts);
  });

  it("handles messages from multiple senders", async () => {
    await writeInbox(team, "agent1", {
      from: "controller",
      text: "From controller",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(team, "agent1", {
      from: "worker2",
      text: "From worker2",
      timestamp: new Date().toISOString(),
    });

    const messages = await readInbox(team, "agent1");
    expect(messages).toHaveLength(2);
    expect(messages[0].from).toBe("controller");
    expect(messages[1].from).toBe("worker2");
  });
});
