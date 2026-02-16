import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import * as sessionNames from "./session-names.js";

const ASSISTANT_DIR = join(homedir(), ".companion", "assistant");
const CONFIG_PATH = join(ASSISTANT_DIR, "config.json");
const CLAUDE_MD_PATH = join(ASSISTANT_DIR, "CLAUDE.md");

/** How long to wait for the CLI to connect after launch (ms) */
const CLI_CONNECT_TIMEOUT_MS = 30_000;
const CLI_CONNECT_POLL_MS = 500;

/** Base delay before auto-relaunching after an unexpected exit */
const RELAUNCH_DELAY_BASE_MS = 3_000;

/** Max relaunch delay (cap for exponential backoff) */
const RELAUNCH_DELAY_MAX_MS = 60_000;

/** Max consecutive crashes before giving up on auto-relaunch */
const MAX_CONSECUTIVE_CRASHES = 5;

export interface AssistantConfig {
  enabled: boolean;
  sessionId: string | null;
  cliSessionId: string | null;
  model: string;
  permissionMode: string;
  createdAt: number;
  lastActiveAt: number;
  contextRestorations: number;
}

const DEFAULT_CONFIG: AssistantConfig = {
  enabled: false,
  sessionId: null,
  cliSessionId: null,
  model: "claude-sonnet-4-5-20250929",
  permissionMode: "bypassPermissions",
  createdAt: 0,
  lastActiveAt: 0,
  contextRestorations: 0,
};

const DEFAULT_CLAUDE_MD = `# Companion

You are the Companion — the brain of The Companion,
a web UI for Claude Code and Codex.

## Your Role
- Help users manage coding sessions, environments, and scheduled tasks
- Orchestrate multi-session workflows (create sessions in project dirs, monitor them)
- Configure environments and schedule autonomous jobs
- Answer questions about the user's projects and coding workflow

## Available Commands

Use \`companion\` to manage The Companion. All commands output JSON.

### Sessions
- \`companion sessions list\` — list all sessions
- \`companion sessions create --cwd <path> [--model <m>] [--env <slug>] [--backend claude|codex]\` — create session
- \`companion sessions kill <id>\` — kill session
- \`companion sessions relaunch <id>\` — restart session
- \`companion sessions send-message <id> "<message>"\` — send message to another session
- \`companion sessions archive <id>\` — archive session
- \`companion sessions rename <id> <name>\` — rename session

### Environments
- \`companion envs list\` — list environments
- \`companion envs create --name <n> --var KEY=VALUE\` — create environment
- \`companion envs get <slug>\` — get environment details
- \`companion envs update <slug> [--var KEY=VALUE]\` — update environment
- \`companion envs delete <slug>\` — delete environment

### Scheduled Tasks
- \`companion cron list\` — list cron jobs
- \`companion cron create --name <n> --schedule "<cron>" --prompt "<p>" --cwd <path>\` — create job
- \`companion cron toggle <id>\` — enable/disable
- \`companion cron run <id>\` — run immediately
- \`companion cron delete <id>\` — delete job

### Skills
- \`companion skills list\` — list installed skills
- \`companion skills get <slug>\` — read a skill's SKILL.md content
- \`companion skills create --name <name> [--description <desc>] [--content <markdown>]\` — create a skill
- \`companion skills update <slug> --content <full SKILL.md content>\` — overwrite a skill
- \`companion skills delete <slug>\` — delete a skill

### Status
- \`companion status\` — overall Companion status

## Creating Skills

Skills are reusable workflow templates for Claude Code. They live in \`~/.claude/skills/<slug>/SKILL.md\`
and become available as \`/<slug>\` commands in all Claude Code sessions.

### Skill File Format

\`\`\`markdown
---
name: my-skill
description: "What this skill does. Trigger phrases: do X, run Y."
---

# My Skill

Instructions for Claude Code when this skill is invoked.

## Steps
1. First do X
2. Then do Y
\`\`\`

### How to Create a Skill

1. Use \`companion skills create --name "my-skill" --description "What it does"\`
2. Then use \`companion skills get my-skill\` to read the generated template
3. Edit with \`companion skills update my-skill --content "<full markdown>"\`

Or write the SKILL.md file directly to \`~/.claude/skills/<slug>/SKILL.md\` using Bash.

The skill will be available in the next Claude Code session as \`/my-skill\`.

## Guidelines
1. For coding tasks: create a NEW session in the right project directory rather than doing work yourself
2. Use worktrees for isolated branch work (\`--worktree --branch <name>\`)
3. Confirm before destructive operations (kill, delete, archive)
4. Suggest appropriate permission modes for new sessions
5. When creating cron jobs, default to bypassPermissions for autonomy
6. You can send messages to other sessions to orchestrate work
7. When creating skills, write clear trigger phrases in the description so Claude Code knows when to suggest them

## User Preferences
(Edit this section to remember preferences across sessions)
`;

export class AssistantManager {
  private launcher: CliLauncher;
  private wsBridge: WsBridge;
  private port: number;
  private config: AssistantConfig = { ...DEFAULT_CONFIG };
  private relaunching = false;
  private consecutiveCrashes = 0;

  constructor(launcher: CliLauncher, wsBridge: WsBridge, port: number) {
    this.launcher = launcher;
    this.wsBridge = wsBridge;
    this.port = port;
    this.loadConfig();
  }

  // ── Config persistence ──────────────────────────────────────────────

  private loadConfig(): void {
    try {
      if (existsSync(CONFIG_PATH)) {
        const raw = readFileSync(CONFIG_PATH, "utf-8");
        this.config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      }
    } catch (e) {
      console.warn("[assistant] Failed to load config:", e);
    }
  }

  private saveConfig(): void {
    try {
      mkdirSync(ASSISTANT_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));
    } catch (e) {
      console.warn("[assistant] Failed to save config:", e);
    }
  }

  // ── Workspace setup ─────────────────────────────────────────────────

  private ensureWorkspace(): void {
    mkdirSync(ASSISTANT_DIR, { recursive: true });

    // Write CLAUDE.md if it doesn't exist (don't overwrite user edits)
    if (!existsSync(CLAUDE_MD_PATH)) {
      writeFileSync(CLAUDE_MD_PATH, DEFAULT_CLAUDE_MD);
      console.log("[assistant] Created CLAUDE.md at", CLAUDE_MD_PATH);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async start(): Promise<SdkSessionInfo | null> {
    if (this.config.sessionId && this.launcher.isAlive(this.config.sessionId)) {
      console.log("[assistant] Already running:", this.config.sessionId);
      return this.launcher.getSession(this.config.sessionId) ?? null;
    }

    this.ensureWorkspace();

    console.log("[assistant] Launching assistant session...");

    const session = this.launcher.launch({
      model: this.config.model,
      permissionMode: this.config.permissionMode,
      cwd: ASSISTANT_DIR,
      backendType: "claude",
      env: {
        COMPANION_PORT: String(this.port),
      },
    });

    this.config.sessionId = session.sessionId;
    this.config.enabled = true;
    if (!this.config.createdAt) this.config.createdAt = Date.now();
    this.config.lastActiveAt = Date.now();
    this.saveConfig();

    // Name the session
    sessionNames.setName(session.sessionId, "Companion");

    try {
      await this.waitForCLIConnection(session.sessionId);

      // Reset crash counter on successful connection
      this.consecutiveCrashes = 0;

      // Send the initial greeting
      this.wsBridge.injectUserMessage(
        session.sessionId,
        "You are the Companion. Say a brief hello and let the user know what you can help with (managing sessions, environments, scheduled tasks, and coding workflows). Keep it to 2-3 sentences.",
      );

      console.log("[assistant] Assistant session started:", session.sessionId);
      return session;
    } catch (e) {
      console.error("[assistant] Failed to start:", e);
      return null;
    }
  }

  async stop(): Promise<boolean> {
    if (!this.config.sessionId) return false;
    const killed = await this.launcher.kill(this.config.sessionId);
    console.log("[assistant] Stopped session:", this.config.sessionId);
    this.config.enabled = false;
    this.config.sessionId = null;
    this.config.cliSessionId = null;
    this.saveConfig();
    return killed;
  }

  getStatus(): {
    running: boolean;
    sessionId: string | null;
    config: AssistantConfig;
    cwd: string;
  } {
    const running = !!this.config.sessionId && this.launcher.isAlive(this.config.sessionId);
    return {
      running,
      sessionId: running ? this.config.sessionId : null,
      config: { ...this.config },
      cwd: ASSISTANT_DIR,
    };
  }

  getSessionId(): string | null {
    return this.config.sessionId;
  }

  getConfig(): AssistantConfig {
    return { ...this.config };
  }

  updateConfig(patch: Partial<Pick<AssistantConfig, "model" | "permissionMode" | "enabled">>): AssistantConfig {
    if (patch.model !== undefined) this.config.model = patch.model;
    if (patch.permissionMode !== undefined) this.config.permissionMode = patch.permissionMode;
    if (patch.enabled !== undefined) this.config.enabled = patch.enabled;
    this.saveConfig();
    return { ...this.config };
  }

  /** Store the CLI's internal session ID for --resume support */
  setCLISessionId(cliSessionId: string): void {
    this.config.cliSessionId = cliSessionId;
    this.saveConfig();
  }

  /** Handle CLI process exit — auto-relaunch with --resume */
  async handleCliExit(sessionId: string): Promise<void> {
    if (sessionId !== this.config.sessionId) return;
    if (this.relaunching) return;

    this.consecutiveCrashes++;

    if (this.consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
      console.error(
        `[assistant] Crash loop detected: ${this.consecutiveCrashes} consecutive crashes. Stopping auto-relaunch.`,
      );
      this.config.enabled = false;
      this.config.sessionId = null;
      this.config.cliSessionId = null;
      this.consecutiveCrashes = 0;
      this.saveConfig();
      return;
    }

    // Exponential backoff: 3s, 6s, 12s, 24s, 48s (capped at 60s)
    const delay = Math.min(
      RELAUNCH_DELAY_BASE_MS * Math.pow(2, this.consecutiveCrashes - 1),
      RELAUNCH_DELAY_MAX_MS,
    );
    console.log(`[assistant] CLI exited, scheduling relaunch in ${delay / 1000}s (crash #${this.consecutiveCrashes})...`);
    this.relaunching = true;

    await new Promise((r) => setTimeout(r, delay));
    this.relaunching = false;

    // Re-check after delay — stop() may have cleared the session
    if (sessionId !== this.config.sessionId || !this.config.enabled) return;

    // Sync cliSessionId from the launcher — it may have been cleared
    // if the CLI exited immediately after --resume (indicating a bad resume)
    const launcherSession = this.launcher.getSession(sessionId);
    if (launcherSession && !launcherSession.cliSessionId) {
      this.config.cliSessionId = null;
      this.saveConfig();
    }

    // Try to relaunch with --resume
    if (this.config.cliSessionId) {
      console.log("[assistant] Relaunching with --resume...");
      const ok = await this.launcher.relaunch(sessionId);
      if (ok) {
        this.config.lastActiveAt = Date.now();
        this.saveConfig();
        return;
      }
    }

    // If relaunch failed, start fresh
    console.log("[assistant] Relaunch failed, starting fresh session...");
    this.config.contextRestorations++;
    this.config.sessionId = null;
    this.config.cliSessionId = null;
    this.saveConfig();

    if (this.config.enabled) {
      await this.start();
    }
  }

  /** Check if a given session ID is the assistant session */
  isAssistantSession(sessionId: string): boolean {
    return this.config.sessionId === sessionId;
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private async waitForCLIConnection(sessionId: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < CLI_CONNECT_TIMEOUT_MS) {
      const info = this.launcher.getSession(sessionId);
      if (info && (info.state === "connected" || info.state === "running")) {
        return;
      }
      if (info?.state === "exited") {
        throw new Error(`CLI process exited before connecting (exit code: ${info.exitCode})`);
      }
      await new Promise((r) => setTimeout(r, CLI_CONNECT_POLL_MS));
    }
    throw new Error(`CLI did not connect within ${CLI_CONNECT_TIMEOUT_MS / 1000}s`);
  }

  destroy(): void {
    // Called on server shutdown — don't kill the assistant, let it persist
  }
}
