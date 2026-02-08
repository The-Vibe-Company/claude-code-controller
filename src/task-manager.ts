import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { defaultPaths, type ClaudePaths } from "./paths.js";
import type { TaskFile, TaskStatus, Logger } from "./types.js";

export class TaskManager {
  private nextId = 1;
  private paths: ClaudePaths;

  constructor(
    private teamName: string,
    private log: Logger,
    paths: ClaudePaths = defaultPaths
  ) {
    this.paths = paths;
  }

  /**
   * Initialize the task directory. Call after team creation.
   * Also scans for existing tasks to set the next ID correctly.
   */
  async init(): Promise<void> {
    const dir = this.paths.tasksDir(this.teamName);
    await mkdir(dir, { recursive: true });

    // Scan existing tasks to find the max ID
    const existing = await this.list();
    if (existing.length > 0) {
      const maxId = Math.max(...existing.map((t) => parseInt(t.id, 10)));
      this.nextId = maxId + 1;
    }
  }

  /**
   * Create a new task. Returns the assigned task ID.
   */
  async create(
    task: Omit<TaskFile, "id" | "blocks" | "blockedBy" | "status"> & {
      blocks?: string[];
      blockedBy?: string[];
      status?: TaskStatus;
    }
  ): Promise<string> {
    const id = String(this.nextId++);
    const full: TaskFile = {
      id,
      subject: task.subject,
      description: task.description,
      activeForm: task.activeForm,
      owner: task.owner,
      status: task.status || "pending",
      blocks: task.blocks || [],
      blockedBy: task.blockedBy || [],
      metadata: task.metadata,
    };

    await this.writeTask(full);
    this.log.debug(`Created task #${id}: ${task.subject}`);
    return id;
  }

  /**
   * Get a task by ID.
   */
  async get(taskId: string): Promise<TaskFile> {
    const path = this.paths.taskPath(this.teamName, taskId);
    if (!existsSync(path)) {
      throw new Error(`Task #${taskId} not found`);
    }
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  }

  /**
   * Update a task. Merges the provided fields.
   */
  async update(
    taskId: string,
    updates: Partial<
      Pick<
        TaskFile,
        | "subject"
        | "description"
        | "activeForm"
        | "owner"
        | "status"
        | "blocks"
        | "blockedBy"
        | "metadata"
      >
    >
  ): Promise<TaskFile> {
    const task = await this.get(taskId);
    Object.assign(task, updates);
    await this.writeTask(task);
    this.log.debug(`Updated task #${taskId}: status=${task.status}`);
    return task;
  }

  /**
   * Add blocking relationships.
   */
  async addBlocks(taskId: string, blockedTaskIds: string[]): Promise<void> {
    const task = await this.get(taskId);
    const toAdd = blockedTaskIds.filter((id) => !task.blocks.includes(id));
    task.blocks.push(...toAdd);
    await this.writeTask(task);

    // Also update the blockedBy on the other tasks
    for (const blockedId of toAdd) {
      const blocked = await this.get(blockedId);
      if (!blocked.blockedBy.includes(taskId)) {
        blocked.blockedBy.push(taskId);
        await this.writeTask(blocked);
      }
    }
  }

  /**
   * List all tasks.
   */
  async list(): Promise<TaskFile[]> {
    const dir = this.paths.tasksDir(this.teamName);
    if (!existsSync(dir)) return [];

    const files = await readdir(dir);
    const tasks: TaskFile[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const raw = await readFile(
        this.paths.taskPath(this.teamName, file.replace(".json", "")),
        "utf-8"
      );
      tasks.push(JSON.parse(raw));
    }

    return tasks.sort((a, b) => parseInt(a.id) - parseInt(b.id));
  }

  /**
   * Delete a task file.
   */
  async delete(taskId: string): Promise<void> {
    const path = this.paths.taskPath(this.teamName, taskId);
    if (existsSync(path)) {
      await rm(path);
      this.log.debug(`Deleted task #${taskId}`);
    }
  }

  /**
   * Wait for a task to reach a target status.
   */
  async waitFor(
    taskId: string,
    targetStatus: TaskStatus = "completed",
    opts?: { timeout?: number; pollInterval?: number }
  ): Promise<TaskFile> {
    const timeout = opts?.timeout ?? 300_000; // 5 min default
    const interval = opts?.pollInterval ?? 1_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const task = await this.get(taskId);
      if (task.status === targetStatus) return task;
      await sleep(interval);
    }

    throw new Error(
      `Timeout waiting for task #${taskId} to reach "${targetStatus}"`
    );
  }

  private async writeTask(task: TaskFile): Promise<void> {
    const path = this.paths.taskPath(this.teamName, task.id);
    await writeFile(path, JSON.stringify(task, null, 4), "utf-8");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
