import { describe, it, expect, beforeEach, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const tempBase = mkdtempSync(join(tmpdir(), "cc-tasks-test-"));

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

const { TaskManager } = await import("../src/task-manager.js");
const { silentLogger } = await import("../src/logger.js");

describe("TaskManager", () => {
  let manager: InstanceType<typeof TaskManager>;

  beforeEach(async () => {
    // Use a unique team name per test to avoid cross-test interference
    const teamName = `test-${randomUUID().slice(0, 8)}`;
    manager = new TaskManager(teamName, silentLogger);
    await manager.init();
  });

  it("creates tasks with incrementing IDs", async () => {
    const id1 = await manager.create({
      subject: "Task 1",
      description: "Do thing 1",
    });
    const id2 = await manager.create({
      subject: "Task 2",
      description: "Do thing 2",
    });

    expect(id1).toBe("1");
    expect(id2).toBe("2");
  });

  it("gets a task by ID", async () => {
    const id = await manager.create({
      subject: "Test task",
      description: "Description",
      activeForm: "Testing",
      owner: "worker",
    });

    const task = await manager.get(id);
    expect(task.id).toBe(id);
    expect(task.subject).toBe("Test task");
    expect(task.description).toBe("Description");
    expect(task.activeForm).toBe("Testing");
    expect(task.owner).toBe("worker");
    expect(task.status).toBe("pending");
    expect(task.blocks).toEqual([]);
    expect(task.blockedBy).toEqual([]);
  });

  it("updates a task", async () => {
    const id = await manager.create({
      subject: "Task",
      description: "Desc",
    });

    const updated = await manager.update(id, {
      status: "in_progress",
      owner: "worker",
    });

    expect(updated.status).toBe("in_progress");
    expect(updated.owner).toBe("worker");
  });

  it("lists all tasks sorted by ID", async () => {
    await manager.create({ subject: "Task A", description: "A" });
    await manager.create({ subject: "Task B", description: "B" });
    await manager.create({ subject: "Task C", description: "C" });

    const tasks = await manager.list();
    expect(tasks).toHaveLength(3);
    expect(tasks[0].subject).toBe("Task A");
    expect(tasks[2].subject).toBe("Task C");
  });

  it("adds blocking relationships", async () => {
    const id1 = await manager.create({
      subject: "Research",
      description: "Research first",
    });
    const id2 = await manager.create({
      subject: "Implement",
      description: "Then implement",
    });

    await manager.addBlocks(id1, [id2]);

    const t1 = await manager.get(id1);
    const t2 = await manager.get(id2);

    expect(t1.blocks).toContain(id2);
    expect(t2.blockedBy).toContain(id1);
  });

  it("deletes a task", async () => {
    const id = await manager.create({
      subject: "Temp",
      description: "Temporary",
    });
    await manager.delete(id);
    await expect(manager.get(id)).rejects.toThrow("not found");
  });

  it("throws on non-existent task", async () => {
    await expect(manager.get("999")).rejects.toThrow("not found");
  });

  it("supports custom initial status", async () => {
    const id = await manager.create({
      subject: "Already started",
      description: "Desc",
      status: "in_progress",
    });
    const task = await manager.get(id);
    expect(task.status).toBe("in_progress");
  });
});
