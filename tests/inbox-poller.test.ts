import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const tempBase = mkdtempSync(join(tmpdir(), "cc-poller-test-"));

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

const { InboxPoller } = await import("../src/inbox-poller.js");
const { writeInbox } = await import("../src/inbox.js");
const { silentLogger } = await import("../src/logger.js");

describe("InboxPoller", () => {
  let team: string;

  beforeEach(() => {
    team = `poller-${randomUUID().slice(0, 8)}`;
  });

  it("polls for messages and calls handler", async () => {
    const poller = new InboxPoller(team, "controller", silentLogger);
    const received: any[] = [];
    poller.onMessages((events: any[]) => received.push(...events));

    await writeInbox(team, "controller", {
      from: "worker",
      text: "Hello from worker",
      timestamp: new Date().toISOString(),
    });

    const events = await poller.poll();
    expect(events).toHaveLength(1);
    expect(events[0].raw.text).toBe("Hello from worker");
    expect(events[0].parsed.type).toBe("plain_text");
    expect(received).toHaveLength(1);
  });

  it("returns empty when no unread messages", async () => {
    const poller = new InboxPoller(team, "controller", silentLogger);
    const events = await poller.poll();
    expect(events).toEqual([]);
  });

  it("parses structured messages during poll", async () => {
    const poller = new InboxPoller(team, "controller", silentLogger);

    const idle = JSON.stringify({
      type: "idle_notification",
      from: "worker",
      timestamp: new Date().toISOString(),
      idleReason: "available",
    });
    await writeInbox(team, "controller", {
      from: "worker",
      text: idle,
      timestamp: new Date().toISOString(),
    });

    const events = await poller.poll();
    expect(events).toHaveLength(1);
    expect(events[0].parsed.type).toBe("idle_notification");
  });

  it("supports multiple handlers", async () => {
    const poller = new InboxPoller(team, "controller", silentLogger);
    const handler1: any[] = [];
    const handler2: any[] = [];
    poller.onMessages((events: any[]) => handler1.push(...events));
    poller.onMessages((events: any[]) => handler2.push(...events));

    await writeInbox(team, "controller", {
      from: "worker",
      text: "Msg",
      timestamp: new Date().toISOString(),
    });

    await poller.poll();
    expect(handler1).toHaveLength(1);
    expect(handler2).toHaveLength(1);
  });

  it("does not re-deliver already-read messages", async () => {
    const poller = new InboxPoller(team, "controller", silentLogger);
    const received: any[] = [];
    poller.onMessages((events: any[]) => received.push(...events));

    await writeInbox(team, "controller", {
      from: "worker",
      text: "Once",
      timestamp: new Date().toISOString(),
    });

    await poller.poll();
    expect(received).toHaveLength(1);

    // Second poll should find nothing new
    await poller.poll();
    expect(received).toHaveLength(1);
  });

  it("start and stop control the polling interval", async () => {
    const poller = new InboxPoller(team, "controller", silentLogger, {
      pollInterval: 100,
    });

    // Verify start creates a timer and stop clears it
    poller.start();
    // Starting again should be no-op
    poller.start();
    poller.stop();
    // Stopping again should be no-op
    poller.stop();
  });

  it("handles handler errors gracefully", async () => {
    const poller = new InboxPoller(team, "controller", silentLogger);
    const good: any[] = [];

    poller.onMessages(() => {
      throw new Error("Handler exploded");
    });
    poller.onMessages((events: any[]) => good.push(...events));

    await writeInbox(team, "controller", {
      from: "worker",
      text: "test",
      timestamp: new Date().toISOString(),
    });

    // Should not throw despite first handler erroring
    const events = await poller.poll();
    expect(events).toHaveLength(1);
    // Second handler should still have been called
    expect(good).toHaveLength(1);
  });

  it("polls multiple messages at once", async () => {
    const poller = new InboxPoller(team, "controller", silentLogger);

    await writeInbox(team, "controller", {
      from: "worker1",
      text: "From worker1",
      timestamp: new Date().toISOString(),
    });
    await writeInbox(team, "controller", {
      from: "worker2",
      text: "From worker2",
      timestamp: new Date().toISOString(),
    });

    const events = await poller.poll();
    expect(events).toHaveLength(2);
    expect(events[0].raw.from).toBe("worker1");
    expect(events[1].raw.from).toBe("worker2");
  });
});
