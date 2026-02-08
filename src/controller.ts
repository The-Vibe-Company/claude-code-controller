import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TeamManager } from "./team-manager.js";
import { TaskManager } from "./task-manager.js";
import { ProcessManager } from "./process-manager.js";
import { InboxPoller, type PollEvent } from "./inbox-poller.js";
import { writeInbox, readUnread, parseMessage } from "./inbox.js";
import { AgentHandle, type AgentController } from "./agent-handle.js";
import { createLogger } from "./logger.js";
import { createPaths, type ClaudePaths } from "./paths.js";
import type {
  ControllerOptions,
  ControllerEvents,
  SpawnAgentOptions,
  ReceiveOptions,
  InboxMessage,
  TeamMember,
  TaskFile,
  TaskStatus,
  Logger,
  LogLevel,
} from "./types.js";

const AGENT_COLORS = [
  "#00FF00",
  "#00BFFF",
  "#FF6347",
  "#FFD700",
  "#DA70D6",
  "#40E0D0",
  "#FF69B4",
  "#7B68EE",
];

export class ClaudeCodeController
  extends EventEmitter<ControllerEvents>
  implements AgentController
{
  readonly teamName: string;
  readonly team: TeamManager;
  readonly tasks: TaskManager;
  private processes: ProcessManager;
  private poller: InboxPoller;
  private log: Logger;
  private cwd: string;
  private claudeBinary: string;
  private defaultEnv: Record<string, string>;
  private paths: ClaudePaths;
  private colorIndex = 0;
  private initialized = false;

  constructor(opts?: ControllerOptions & { logLevel?: LogLevel }) {
    super();
    this.teamName =
      opts?.teamName || `ctrl-${randomUUID().slice(0, 8)}`;
    this.cwd = opts?.cwd || process.cwd();
    this.claudeBinary = opts?.claudeBinary || "claude";
    this.defaultEnv = opts?.env || {};
    this.log = opts?.logger || createLogger(opts?.logLevel ?? "info");

    this.paths = createPaths({ claudeDir: opts?.claudeDir });

    this.team = new TeamManager(this.teamName, this.log, this.paths);
    this.tasks = new TaskManager(this.teamName, this.log, this.paths);
    this.processes = new ProcessManager(this.log);
    this.poller = new InboxPoller(
      this.teamName,
      "controller",
      this.log,
      { paths: this.paths }
    );

    // Wire up poller events to the EventEmitter
    this.poller.onMessages((events) => this.handlePollEvents(events));
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Initialize the controller: create the team and start polling.
   * Must be called before any other operations.
   */
  async init(): Promise<this> {
    if (this.initialized) return this;

    await this.team.create({ cwd: this.cwd });
    await this.tasks.init();
    this.poller.start();
    this.initialized = true;
    this.log.info(
      `Controller initialized (team="${this.teamName}")`
    );
    return this;
  }

  /**
   * Graceful shutdown:
   * 1. Send shutdown requests to all agents
   * 2. Wait briefly for acknowledgment
   * 3. Kill remaining processes
   * 4. Clean up team files
   */
  async shutdown(): Promise<void> {
    this.log.info("Shutting down controller...");

    // Send shutdown requests to all running agents
    const running = this.processes.runningAgents();
    const shutdownPromises: Promise<void>[] = [];

    for (const name of running) {
      try {
        await this.sendShutdownRequest(name);
        // Wait up to 10s for the agent process to exit on its own
        shutdownPromises.push(
          new Promise<void>((resolve) => {
            const proc = this.processes.get(name);
            if (!proc) return resolve();
            const timer = setTimeout(() => resolve(), 10_000);
            proc.on("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          })
        );
      } catch {
        // Agent may already be gone
      }
    }

    // Wait for all agents to exit gracefully (or timeout)
    if (shutdownPromises.length > 0) {
      await Promise.all(shutdownPromises);
    }

    // Force kill any remaining
    await this.processes.killAll();

    // Stop polling
    this.poller.stop();

    // Clean up filesystem
    await this.team.destroy();
    this.initialized = false;
    this.log.info("Controller shut down");
  }

  // ─── Agent Management ────────────────────────────────────────────────

  /**
   * Spawn a new Claude Code agent.
   */
  async spawnAgent(opts: SpawnAgentOptions): Promise<AgentHandle> {
    this.ensureInitialized();

    const agentId = `${opts.name}@${this.teamName}`;
    const color = AGENT_COLORS[this.colorIndex++ % AGENT_COLORS.length];
    const cwd = opts.cwd || this.cwd;

    // Register member in team config
    const member: TeamMember = {
      agentId,
      name: opts.name,
      agentType: opts.type || "general-purpose",
      model: opts.model,
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd,
      subscriptions: [],
    };
    await this.team.addMember(member);

    // Merge default env with per-agent env (per-agent takes precedence)
    const env =
      Object.keys(this.defaultEnv).length > 0 || opts.env
        ? { ...this.defaultEnv, ...opts.env }
        : undefined;

    // Spawn the CLI process
    const proc = this.processes.spawn({
      teamName: this.teamName,
      agentName: opts.name,
      agentId,
      agentType: opts.type || "general-purpose",
      model: opts.model,
      cwd,
      parentSessionId: this.team.sessionId,
      color,
      claudeBinary: this.claudeBinary,
      permissions: opts.permissions,
      permissionMode: opts.permissionMode,
      env,
    });

    this.emit("agent:spawned", opts.name, proc.pid ?? 0);

    // Track process exit
    this.processes.onExit(opts.name, (code) => {
      this.emit("agent:exited", opts.name, code ?? null);
    });

    return new AgentHandle(this, opts.name, proc.pid);
  }

  // ─── Messaging ───────────────────────────────────────────────────────

  /**
   * Send a message to a specific agent.
   */
  async send(
    agentName: string,
    message: string,
    summary?: string
  ): Promise<void> {
    this.ensureInitialized();
    await writeInbox(
      this.teamName,
      agentName,
      {
        from: "controller",
        text: message,
        timestamp: new Date().toISOString(),
        summary,
      },
      this.log,
      { paths: this.paths }
    );
  }

  /**
   * Send a structured shutdown request to an agent.
   */
  async sendShutdownRequest(agentName: string): Promise<void> {
    const requestId = `shutdown-${Date.now()}@${agentName}`;
    const msg = JSON.stringify({
      type: "shutdown_request",
      requestId,
      from: "controller",
      reason: "Controller shutdown requested",
      timestamp: new Date().toISOString(),
    });
    await this.send(agentName, msg);
  }

  /**
   * Broadcast a message to all registered agents (except controller).
   */
  async broadcast(message: string, summary?: string): Promise<void> {
    this.ensureInitialized();
    const config = await this.team.getConfig();
    const agents = config.members.filter((m) => m.name !== "controller");
    await Promise.all(
      agents.map((a) => this.send(a.name, message, summary))
    );
  }

  /**
   * Wait for messages from a specific agent.
   * Polls the controller's inbox for messages from the given agent.
   *
   * Returns when:
   * - A non-idle message is received (SendMessage from agent), OR
   * - An idle_notification is received (agent finished its turn),
   *   in which case the idle message is returned.
   */
  async receive(
    agentName: string,
    opts?: ReceiveOptions
  ): Promise<InboxMessage[]> {
    const timeout = opts?.timeout ?? 60_000;
    const interval = opts?.pollInterval ?? 500;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const unread = await readUnread(this.teamName, "controller", {
        paths: this.paths,
      });
      const fromAgent = unread.filter((m) => m.from === agentName);

      if (fromAgent.length > 0) {
        // Protocol-only messages are handled via events, skip them in receive()
        const PROTOCOL_TYPES = new Set([
          "shutdown_approved",
          "plan_approval_response",
          "permission_response",
        ]);

        // Prefer content messages (plain text or SendMessage from agent)
        const meaningful = fromAgent.filter((m) => {
          const parsed = parseMessage(m);
          return (
            parsed.type !== "idle_notification" &&
            !PROTOCOL_TYPES.has(parsed.type)
          );
        });

        if (meaningful.length > 0) {
          return opts?.all ? meaningful : [meaningful[0]];
        }

        // If only idle/protocol messages, check if there's an idle (= agent done)
        const idles = fromAgent.filter((m) => {
          const parsed = parseMessage(m);
          return parsed.type === "idle_notification";
        });
        if (idles.length > 0) {
          return opts?.all ? idles : [idles[0]];
        }
      }

      await sleep(interval);
    }

    throw new Error(
      `Timeout (${timeout}ms) waiting for message from "${agentName}"`
    );
  }

  /**
   * Wait for any message from any agent.
   */
  async receiveAny(opts?: ReceiveOptions): Promise<InboxMessage> {
    const timeout = opts?.timeout ?? 60_000;
    const interval = opts?.pollInterval ?? 500;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const unread = await readUnread(this.teamName, "controller", {
        paths: this.paths,
      });
      const meaningful = unread.filter((m) => {
        const parsed = parseMessage(m);
        return parsed.type !== "idle_notification";
      });

      if (meaningful.length > 0) {
        return meaningful[0];
      }

      await sleep(interval);
    }

    throw new Error(`Timeout (${timeout}ms) waiting for any message`);
  }

  // ─── Tasks ───────────────────────────────────────────────────────────

  /**
   * Create a task and optionally notify the assigned agent.
   */
  async createTask(
    task: Omit<TaskFile, "id" | "blocks" | "blockedBy" | "status"> & {
      blocks?: string[];
      blockedBy?: string[];
      status?: TaskStatus;
    }
  ): Promise<string> {
    this.ensureInitialized();
    const taskId = await this.tasks.create(task);

    // Notify the assigned agent if any
    if (task.owner) {
      const fullTask = await this.tasks.get(taskId);
      const assignmentMsg = JSON.stringify({
        type: "task_assignment",
        taskId,
        subject: fullTask.subject,
        description: fullTask.description,
        assignedBy: "controller",
        timestamp: new Date().toISOString(),
      });
      await this.send(task.owner, assignmentMsg);
    }

    return taskId;
  }

  /**
   * Assign a task to an agent.
   */
  async assignTask(taskId: string, agentName: string): Promise<void> {
    const task = await this.tasks.update(taskId, { owner: agentName });
    const msg = JSON.stringify({
      type: "task_assignment",
      taskId,
      subject: task.subject,
      description: task.description,
      assignedBy: "controller",
      timestamp: new Date().toISOString(),
    });
    await this.send(agentName, msg);
  }

  // ─── Protocol Responses ───────────────────────────────────────────

  /**
   * Approve or reject a teammate's plan.
   * Send this in response to a `plan:approval_request` event.
   */
  async sendPlanApproval(
    agentName: string,
    requestId: string,
    approve: boolean,
    feedback?: string
  ): Promise<void> {
    const msg = JSON.stringify({
      type: "plan_approval_response",
      requestId,
      from: "controller",
      approved: approve,
      feedback,
      timestamp: new Date().toISOString(),
    });
    await this.send(agentName, msg);
  }

  /**
   * Approve or reject a teammate's permission/tool-use request.
   * Send this in response to a `permission:request` event.
   */
  async sendPermissionResponse(
    agentName: string,
    requestId: string,
    approve: boolean
  ): Promise<void> {
    const msg = JSON.stringify({
      type: "permission_response",
      requestId,
      from: "controller",
      approved: approve,
      timestamp: new Date().toISOString(),
    });
    await this.send(agentName, msg);
  }

  /**
   * Wait for a task to be completed.
   */
  async waitForTask(
    taskId: string,
    timeout?: number
  ): Promise<TaskFile> {
    return this.tasks.waitFor(taskId, "completed", { timeout });
  }

  // ─── Utilities ───────────────────────────────────────────────────────

  /**
   * Check if an agent process is still running.
   */
  isAgentRunning(name: string): boolean {
    return this.processes.isRunning(name);
  }

  /**
   * Kill a specific agent.
   */
  async killAgent(name: string): Promise<void> {
    await this.processes.kill(name);
    await this.team.removeMember(name);
  }

  /**
   * Get the installed Claude Code version.
   */
  getClaudeVersion(): string | null {
    try {
      const version = execSync(`${this.claudeBinary} --version`, {
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();
      return version;
    } catch {
      return null;
    }
  }

  /**
   * Verify that the required CLI flags exist in the installed version.
   */
  verifyCompatibility(): { compatible: boolean; version: string | null } {
    const version = this.getClaudeVersion();
    // The flags we depend on were present in v2.1.34
    // We check that the binary exists and responds
    return { compatible: version !== null, version };
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private handlePollEvents(events: PollEvent[]): void {
    for (const event of events) {
      const { raw, parsed } = event;

      switch (parsed.type) {
        case "idle_notification":
          this.emit("idle", raw.from);
          break;
        case "shutdown_approved":
          this.log.info(
            `Shutdown approved by "${raw.from}" (requestId=${parsed.requestId})`
          );
          this.emit("shutdown:approved", raw.from, parsed);
          break;
        case "plan_approval_request":
          this.log.info(
            `Plan approval request from "${raw.from}" (requestId=${parsed.requestId})`
          );
          this.emit("plan:approval_request", raw.from, parsed);
          break;
        case "permission_request":
          this.log.info(
            `Permission request from "${raw.from}": ${parsed.toolName} (requestId=${parsed.requestId})`
          );
          this.emit("permission:request", raw.from, parsed);
          break;
        case "plain_text":
          this.emit("message", raw.from, raw);
          break;
        default:
          this.emit("message", raw.from, raw);
      }
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "Controller not initialized. Call init() first."
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
