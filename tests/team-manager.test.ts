import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempBase = mkdtempSync(join(tmpdir(), "cc-test-"));

// We need to mock the paths module to use temp directories
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

const { TeamManager } = await import("../src/team-manager.js");
const { silentLogger } = await import("../src/logger.js");

describe("TeamManager", () => {
  let manager: InstanceType<typeof TeamManager>;

  beforeEach(() => {
    manager = new TeamManager("test-team", silentLogger);
  });

  afterEach(async () => {
    try {
      await manager.destroy();
    } catch {
      // ignore cleanup errors
    }
  });

  it("creates a team with config.json", async () => {
    const config = await manager.create({ description: "Test team" });

    expect(config.name).toBe("test-team");
    expect(config.description).toBe("Test team");
    expect(config.leadAgentId).toBe("controller@test-team");
    expect(config.members).toHaveLength(1);
    expect(config.members[0].name).toBe("controller");
  });

  it("adds a member", async () => {
    await manager.create();
    await manager.addMember({
      agentId: "worker@test-team",
      name: "worker",
      agentType: "general-purpose",
      joinedAt: Date.now(),
      cwd: "/tmp",
    });

    const config = await manager.getConfig();
    expect(config.members).toHaveLength(2);
    expect(config.members[1].name).toBe("worker");
  });

  it("removes a member", async () => {
    await manager.create();
    await manager.addMember({
      agentId: "worker@test-team",
      name: "worker",
      agentType: "general-purpose",
      joinedAt: Date.now(),
      cwd: "/tmp",
    });
    await manager.removeMember("worker");

    const config = await manager.getConfig();
    expect(config.members).toHaveLength(1);
    expect(config.members[0].name).toBe("controller");
  });

  it("replaces member on duplicate name", async () => {
    await manager.create();
    await manager.addMember({
      agentId: "worker@test-team",
      name: "worker",
      agentType: "general-purpose",
      joinedAt: Date.now(),
      cwd: "/tmp",
    });
    await manager.addMember({
      agentId: "worker@test-team",
      name: "worker",
      agentType: "Bash",
      joinedAt: Date.now(),
      cwd: "/tmp/new",
    });

    const config = await manager.getConfig();
    const workers = config.members.filter((m: any) => m.name === "worker");
    expect(workers).toHaveLength(1);
    expect(workers[0].agentType).toBe("Bash");
  });

  it("detects existence", async () => {
    expect(manager.exists()).toBe(false);
    await manager.create();
    expect(manager.exists()).toBe(true);
  });

  it("destroys the team", async () => {
    await manager.create();
    expect(manager.exists()).toBe(true);
    await manager.destroy();
    expect(manager.exists()).toBe(false);
  });

  it("throws on getConfig for non-existent team", async () => {
    await expect(manager.getConfig()).rejects.toThrow("does not exist");
  });
});
