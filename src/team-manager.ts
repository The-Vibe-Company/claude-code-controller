import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { defaultPaths, type ClaudePaths } from "./paths.js";
import type { TeamConfig, TeamMember, Logger } from "./types.js";

export class TeamManager {
  readonly teamName: string;
  readonly sessionId: string;
  private log: Logger;
  private paths: ClaudePaths;

  constructor(teamName: string, logger: Logger, paths: ClaudePaths = defaultPaths) {
    this.teamName = teamName;
    this.sessionId = randomUUID();
    this.log = logger;
    this.paths = paths;
  }

  /**
   * Create the team directory structure and config.json.
   * The controller registers itself as the lead member.
   */
  async create(opts?: {
    description?: string;
    cwd?: string;
  }): Promise<TeamConfig> {
    const dir = this.paths.teamDir(this.teamName);
    const inboxDir = this.paths.inboxesDir(this.teamName);
    const taskDir = this.paths.tasksDir(this.teamName);

    await mkdir(dir, { recursive: true });
    await mkdir(inboxDir, { recursive: true });
    await mkdir(taskDir, { recursive: true });

    const leadName = "controller";
    const leadAgentId = `${leadName}@${this.teamName}`;

    const config: TeamConfig = {
      name: this.teamName,
      description: opts?.description,
      createdAt: Date.now(),
      leadAgentId,
      leadSessionId: this.sessionId,
      members: [
        {
          agentId: leadAgentId,
          name: leadName,
          agentType: "controller",
          joinedAt: Date.now(),
          tmuxPaneId: "",
          cwd: opts?.cwd || process.cwd(),
          subscriptions: [],
        },
      ],
    };

    await this.writeConfig(config);
    this.log.info(`Team "${this.teamName}" created`);
    return config;
  }

  /**
   * Add a member to the team config.
   */
  async addMember(member: TeamMember): Promise<void> {
    const config = await this.getConfig();
    // Remove existing member with same name if any
    config.members = config.members.filter((m) => m.name !== member.name);
    config.members.push(member);
    await this.writeConfig(config);
    this.log.debug(`Added member "${member.name}" to team`);
  }

  /**
   * Remove a member from the team config.
   */
  async removeMember(name: string): Promise<void> {
    const config = await this.getConfig();
    config.members = config.members.filter((m) => m.name !== name);
    await this.writeConfig(config);
    this.log.debug(`Removed member "${name}" from team`);
  }

  /**
   * Read the current team config.
   */
  async getConfig(): Promise<TeamConfig> {
    const path = this.paths.teamConfigPath(this.teamName);
    if (!existsSync(path)) {
      throw new Error(
        `Team "${this.teamName}" does not exist (no config.json)`
      );
    }
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  }

  /**
   * Check if the team already exists on disk.
   */
  exists(): boolean {
    return existsSync(this.paths.teamConfigPath(this.teamName));
  }

  /**
   * Destroy the team: remove all team directories and task directories.
   */
  async destroy(): Promise<void> {
    const dir = this.paths.teamDir(this.teamName);
    const taskDir = this.paths.tasksDir(this.teamName);

    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
    if (existsSync(taskDir)) {
      await rm(taskDir, { recursive: true, force: true });
    }
    this.log.info(`Team "${this.teamName}" destroyed`);
  }

  private async writeConfig(config: TeamConfig): Promise<void> {
    const path = this.paths.teamConfigPath(this.teamName);
    await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
  }
}
