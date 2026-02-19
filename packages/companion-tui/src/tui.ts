#!/usr/bin/env bun
// companion-tui - Terminal client for Companion server
// Connects as a "browser" client via WebSocket to share sessions with the web UI

import chalk from "chalk";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TUI,
  ProcessTerminal,
  Markdown,
  Text,
  Spacer,
  Loader,
  SelectList,
  CombinedAutocompleteProvider,
  matchesKey,
  type Component,
  type SelectItem,
  type SlashCommand,
  CURSOR_MARKER,
  visibleWidth,
} from "@mariozechner/pi-tui";
import {
  CompanionClient,
  createSession,
  listBackendModels,
  listSessions,
  relaunchSession,
  type ConnectionStatus,
  type BackendModelInfo,
  type SessionInfo,
} from "./companion-client.ts";
import type {
  ServerMessage,
  ContentBlock,
  PermissionRequest,
  SessionState,
  McpServerDetail,
} from "./types.ts";
import {
  AppKeybindingsManager,
  BUILTIN_SLASH_COMMANDS,
  CustomEditor,
  getEditorTheme,
  getMarkdownTheme,
  getSelectListTheme,
  initTheme,
  readClipboardImage,
  SessionSelectorComponent,
  type SessionInfo as PiSessionInfo,
} from "@mariozechner/pi-coding-agent";

// -- Themes ------------------------------------------------------------------

initTheme();
const selectListTheme = getSelectListTheme();
const markdownTheme = getMarkdownTheme();
const editorTheme = getEditorTheme();

// -- Permission Banner -------------------------------------------------------

class PermissionBanner implements Component {
  focused = false;
  private request: PermissionRequest;
  private onRespond: (behavior: "allow" | "deny") => void;
  private tui: TUI;

  constructor(
    tui: TUI,
    request: PermissionRequest,
    onRespond: (behavior: "allow" | "deny") => void,
  ) {
    this.tui = tui;
    this.request = request;
    this.onRespond = onRespond;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const r = this.request;
    const inputStr = formatToolInput(r.tool_name, r.input);
    const lines = [
      "",
      chalk.bgYellow.black(` PERMISSION REQUEST `),
      chalk.yellow(`Tool: ${r.tool_name}`),
    ];
    if (inputStr) {
      for (const line of inputStr.split("\n").slice(0, 10)) {
        lines.push(chalk.dim(`  ${line}`));
      }
      if (inputStr.split("\n").length > 10) {
        lines.push(chalk.dim(`  ... (truncated)`));
      }
    }
    lines.push("");
    lines.push(
      `  ${chalk.green("[y] Allow")}  ${chalk.red("[n] Deny")}  ${chalk.blue("[a] Always allow")}`,
    );
    lines.push("");
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "y") || matchesKey(data, "enter")) {
      this.onRespond("allow");
    } else if (matchesKey(data, "n") || matchesKey(data, "escape")) {
      this.onRespond("deny");
    } else if (matchesKey(data, "a")) {
      // "always allow" -- for now same as allow, could add rule update later
      this.onRespond("allow");
    }
  }
}

// -- Status Bar --------------------------------------------------------------

class StatusBar implements Component {
  connectionStatus: ConnectionStatus = "disconnected";
  cliConnected: boolean | null = null;
  session: SessionState | null = null;
  isRunning = false;
  gitBranch: string | null = null;
  pendingImages = 0;

  invalidate(): void {}

  render(width: number): string[] {
    const parts: string[] = [];

    // Connection indicator
    const connIcon =
      this.connectionStatus === "connected"
        ? "●"
        : this.connectionStatus === "connecting"
          ? "◐"
          : "○";
    parts.push(connIcon);
    if (this.cliConnected !== null) {
      parts.push(this.cliConnected ? chalk.green("cli:up") : chalk.red("cli:down"));
    }

    if (this.session) {
      if (this.session.model) {
        parts.push(this.session.model);
      }
      if (
        this.session.permissionMode &&
        this.session.permissionMode !== "default"
      ) {
        parts.push(this.session.permissionMode);
      }
      if (this.session.total_cost_usd > 0) {
        parts.push(`$${this.session.total_cost_usd.toFixed(4)}`);
      }
      if (this.session.context_used_percent > 0) {
        parts.push(`ctx:${this.session.context_used_percent}%`);
      }
    }

    if (this.gitBranch) {
      parts.push(`⎇ ${this.gitBranch}`);
    }

    if (this.pendingImages > 0) {
      parts.push(`img:${this.pendingImages}`);
    }

    if (this.isRunning) {
      parts.push("⟳ running");
      parts.push("ESC to interrupt");
    }

    const innerWidth = Math.max(0, width - 2);
    const line = truncateToWidth(parts.join(" | "), innerWidth);
    const paddedLine = `${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))}`;
    return [chalk.bgBlack(` ${paddedLine} `)];
  }
}

// -- Selector Overlay --------------------------------------------------------

class SelectorOverlay implements Component {
  focused = false;
  private title: string;
  private items: SelectItem[];
  private list: SelectList;

  constructor(
    title: string,
    items: SelectItem[],
    maxVisible: number,
    onSelect: (item: SelectItem) => void,
    onCancel: () => void,
  ) {
    this.title = title;
    this.items = items;
    this.list = new SelectList(items, maxVisible, selectListTheme);
    this.list.onSelect = onSelect;
    this.list.onCancel = onCancel;
  }

  setSelectedValue(value: string): void {
    const selected = this.list.getSelectedItem();
    if (selected?.value === value) return;

    // SelectList keeps the original list order; this mirrors how pi pre-selects current values.
    const index = this.items.findIndex((item) => item.value === value);
    if (index >= 0) {
      this.list.setSelectedIndex(index);
    }
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    return [
      chalk.bold(this.title),
      chalk.dim("Type to filter, Enter to select, Esc to cancel"),
      "",
      ...this.list.render(width),
    ];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

// -- Helpers -----------------------------------------------------------------

function formatToolInput(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "Bash" && typeof input.command === "string") {
    return `$ ${input.command}`;
  }
  if (
    (toolName === "Read" || toolName === "Write" || toolName === "Edit") &&
    typeof input.file_path === "string"
  ) {
    return input.file_path;
  }
  if (toolName === "Grep" && typeof input.pattern === "string") {
    return `grep ${input.pattern}`;
  }
  if (toolName === "Glob" && typeof input.pattern === "string") {
    return `glob ${input.pattern}`;
  }
  return JSON.stringify(input, null, 2);
}

function extractText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      parts.push(
        `\n${chalk.dim(`⚡ ${block.name}`)} ${chalk.dim(formatToolInput(block.name, block.input))}\n`,
      );
    } else if (block.type === "thinking") {
      parts.push(chalk.dim.italic(`💭 ${block.thinking}`));
    }
  }
  return parts.join("");
}

interface ModelOption {
  value: string;
  label: string;
  description: string;
}

type BackendType = "claude" | "codex";

const CLAUDE_MODEL_FALLBACKS: ModelOption[] = [
  {
    value: "claude-opus-4-6",
    label: "Opus",
    description: "Most capable",
  },
  {
    value: "claude-sonnet-4-5-20250929",
    label: "Sonnet",
    description: "Balanced",
  },
  {
    value: "claude-haiku-4-5-20251001",
    label: "Haiku",
    description: "Quick, lightweight",
  },
];

const CODEX_MODEL_FALLBACKS: ModelOption[] = [
  {
    value: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    description: "Top coding quality",
  },
  {
    value: "gpt-5.2-codex",
    label: "GPT-5.2 Codex",
    description: "Strong coding model",
  },
  {
    value: "gpt-5.1-codex-mini",
    label: "GPT-5.1 Mini",
    description: "Fast + lightweight",
  },
];

function getBackendType(session: SessionState | null): BackendType {
  return session?.backend_type === "codex" ? "codex" : "claude";
}

function fallbackModelsForBackend(backend: BackendType): ModelOption[] {
  return backend === "codex" ? CODEX_MODEL_FALLBACKS : CLAUDE_MODEL_FALLBACKS;
}

function fallbackModesForBackend(backend: BackendType): SelectItem[] {
  if (backend === "codex") {
    return [
      {
        label: "bypassPermissions",
        value: "bypassPermissions",
        description: "Auto mode",
      },
      {
        label: "acceptEdits",
        value: "acceptEdits",
        description: "Accept edits automatically",
      },
      {
        label: "plan",
        value: "plan",
        description: "Suggest changes only",
      },
    ];
  }

  return [
    {
      label: "default",
      value: "default",
      description: "Ask for permissions",
    },
    {
      label: "plan",
      value: "plan",
      description: "Read-only, no writes",
    },
    {
      label: "bypassPermissions",
      value: "bypassPermissions",
      description: "Skip all permission checks",
    },
  ];
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim() || mimeType;
}

function buildAutocompleteSlashCommands(): SlashCommand[] {
  const defaults: SlashCommand[] = [
    { name: "help", description: "Show help" },
    { name: "clear", description: "Clear conversation" },
    { name: "quit", description: "Exit companion-tui" },
    { name: "exit", description: "Exit companion-tui" },
    { name: "mcp", description: "MCP server status" },
    { name: "model", description: "Switch model" },
    { name: "mode", description: "Switch permission mode" },
    { name: "status", description: "Show session info" },
    { name: "compact", description: "Compact context" },
  ];

  const overrides = new Map(
    BUILTIN_SLASH_COMMANDS
      .filter((c) => c.name === "model" || c.name === "compact" || c.name === "quit")
      .map((c) => [c.name, c.description]),
  );
  for (const cmd of defaults) {
    const description = overrides.get(cmd.name);
    if (description) cmd.description = description;
  }

  return defaults;
}

// -- Main App ----------------------------------------------------------------

// -- CLI Args ----------------------------------------------------------------

interface CliArgs {
  continue: boolean;
  resume: boolean;
  resumeId?: string;
  model?: string;
  help: boolean;
  host: string;
}

function parseCliArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {
    continue: false,
    resume: false,
    help: false,
    host: process.env.COMPANION_HOST ?? "localhost:3456",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "-c" || arg === "--continue") {
      args.continue = true;
    } else if (arg === "-r" || arg === "--resume") {
      args.resume = true;
      // Peek at next arg: if it exists and doesn't start with -, it's the session ID
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        args.resumeId = next;
        i++;
      }
    } else if (arg === "--host") {
      const next = argv[++i];
      if (!next) {
        console.error(chalk.red("--host requires a value"));
        process.exit(1);
      }
      args.host = next;
    } else if (arg === "-m" || arg === "--model") {
      const next = argv[++i];
      if (!next) {
        console.error(chalk.red(`${arg} requires a model value`));
        process.exit(1);
      }
      const parsed = parseModelInput(next);
      if (!parsed) {
        console.error(chalk.red(`${arg} requires a non-empty model value`));
        process.exit(1);
      }
      args.model = parsed;
    } else {
      console.error(chalk.red(`Unknown argument: ${arg}`));
      printUsage();
      process.exit(1);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`${chalk.bold("companion-tui")} — TUI client for Claude Code via Companion

${chalk.dim("Usage:")}
  companion-tui                Create a new session
  companion-tui -c             Resume the most recent session (relaunch if exited)
  companion-tui -r             Pick a session to resume interactively
  companion-tui -r <id>        Resume a specific session by ID (prefix match)

${chalk.dim("Options:")}
  -c, --continue               Resume the most recent session
  -r, --resume [id]            Resume a session (interactive picker if no ID)
  -m, --model <model>          Start with model (creates new session by default)
  -h, --help                   Show this help
  --host <host:port>           Companion server (default: localhost:3456)
`);
}

// -- Session Resolution ------------------------------------------------------

function formatSessionRef(
  sessionId: string,
  sessionName?: string | null,
): string {
  if (sessionName) {
    return `${sessionId} (${sessionName})`;
  }
  return sessionId;
}

function formatHeaderTitle(
  sessionId: string,
  sessionName?: string | null,
): string {
  return (
    chalk.bold("companion-tui") +
    chalk.dim(` — session ${formatSessionRef(sessionId, sessionName)}`)
  );
}

function parseModelInput(model: string): string {
  return model.trim();
}

function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return "…";

  const ellipsis = "…";
  let result = text;
  while (result.length > 0 && visibleWidth(result + ellipsis) > maxWidth) {
    result = result.slice(0, -1);
  }
  return result + ellipsis;
}

function isAlive(s: SessionInfo): boolean {
  return s.state === "connected" || s.state === "running" || s.state === "idle";
}

async function ensureAlive(
  host: string,
  session: SessionInfo,
): Promise<void> {
  if (isAlive(session)) return;
  console.log(
    chalk.dim(
      `Session ${formatSessionRef(session.sessionId, session.name)} is ${session.state}, relaunching...`,
    ),
  );
  await relaunchSession(host, session.sessionId);
  await new Promise((r) => setTimeout(r, 2000));
}

function findByPrefix(
  sessions: SessionInfo[],
  prefix: string,
): SessionInfo | undefined {
  const exact = sessions.find((s) => s.sessionId === prefix);
  if (exact) return exact;
  const matches = sessions.filter((s) => s.sessionId.startsWith(prefix));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(chalk.red(`Ambiguous session prefix "${prefix}", matches:`));
    for (const m of matches) {
      console.error(
        chalk.dim(`  ${m.sessionId}  ${m.state}  ${m.name ?? m.cwd}`),
      );
    }
    process.exit(1);
  }
  return undefined;
}

function toDate(ts: number | undefined): Date {
  if (!ts || Number.isNaN(ts)) return new Date();
  const normalized = ts < 1_000_000_000_000 ? ts * 1000 : ts;
  return new Date(normalized);
}

function toPiSessionInfo(s: SessionInfo): PiSessionInfo {
  const created = toDate(s.createdAt);
  const shortId = s.sessionId.slice(0, 8);
  const displayName = s.name?.trim();
  const label = displayName && displayName.length > 0
    ? displayName
    : `Session ${shortId}`;

  return {
    path: s.sessionId,
    id: s.sessionId,
    cwd: s.cwd,
    name: displayName,
    created,
    modified: created,
    messageCount: 0,
    firstMessage: label,
    allMessagesText: `${label} ${shortId} ${s.sessionId} ${s.state} ${s.cwd}`,
  };
}

/** Show an interactive session picker using pi-coding-agent SessionSelectorComponent. */
function pickSession(
  localSessions: SessionInfo[],
  allSessions: SessionInfo[],
): Promise<SessionInfo | null> {
  return new Promise((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);

    const byId = new Map(allSessions.map((s) => [s.sessionId, s]));
    const localPiSessions = [...localSessions]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .map(toPiSessionInfo);
    const allPiSessions = [...allSessions]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .map(toPiSessionInfo);

    const keybindings = AppKeybindingsManager.inMemory();
    const selector = new SessionSelectorComponent(
      async (onProgress) => {
        onProgress?.(localPiSessions.length, localPiSessions.length);
        return localPiSessions;
      },
      async (onProgress) => {
        onProgress?.(allPiSessions.length, allPiSessions.length);
        return allPiSessions;
      },
      (sessionPath) => {
        tui.stop();
        resolve(byId.get(sessionPath) ?? null);
      },
      () => {
        tui.stop();
        resolve(null);
      },
      () => {
        tui.stop();
        resolve(null);
      },
      () => tui.requestRender(),
      { keybindings, showRenameHint: false },
    );

    tui.addChild(selector);
    tui.setFocus(selector);
    tui.start();
  });
}

// -- Main App ----------------------------------------------------------------

async function main() {
  const args = parseCliArgs();

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const host = args.host;
  const requestedModel = args.model ? parseModelInput(args.model) : null;
  const requestModelAfterConnect =
    requestedModel !== null && (args.resume || args.continue);
  let modelRequestedAfterConnect = false;

  // Resolve session
  const cwd = process.cwd();
  let sessionId: string;
  let sessionName: string | null = null;
  try {
    const allSessions = await listSessions(host);
    // Filter to current directory for browsing/auto-selection
    const localSessions = allSessions.filter((s) => s.cwd === cwd);

    if (args.resume) {
      if (args.resumeId) {
        // --resume <id>: explicit ID -- search ALL sessions (user knows what they want)
        const session = findByPrefix(allSessions, args.resumeId);
        if (!session) {
          console.error(
            chalk.red(`No session found matching "${args.resumeId}"`),
          );
          const recent = allSessions
            .filter((s) => s.cwd === cwd)
            .slice(-10);
          if (recent.length > 0) {
            console.error(chalk.dim("Sessions in this directory:"));
            for (const s of recent) {
              console.error(
                chalk.dim(
                  `  ${s.sessionId}  ${s.state.padEnd(10)}  ${s.name ?? s.cwd}`,
                ),
              );
            }
          }
          process.exit(1);
        }
        await ensureAlive(host, session);
        sessionId = session.sessionId;
        sessionName = session.name ?? null;
        console.log(
          chalk.dim(`Resuming session ${formatSessionRef(sessionId, sessionName)}...`),
        );
      } else {
        // --resume (no id): interactive picker scoped to cwd
        if (localSessions.length === 0) {
          console.error(
            chalk.red(`No sessions in ${cwd}`),
          );
          process.exit(1);
        }
        const picked = await pickSession(localSessions, allSessions);
        if (!picked) {
          process.exit(0);
        }
        await ensureAlive(host, picked);
        sessionId = picked.sessionId;
        sessionName = picked.name ?? null;
      }
    } else if (args.continue) {
      // --continue: most recent session in this directory
      if (localSessions.length === 0) {
        console.error(chalk.red(`No sessions to continue in ${cwd}`));
        process.exit(1);
      }
      const sorted = [...localSessions].sort(
        (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
      );
      const session = sorted[0]!;
      await ensureAlive(host, session);
      sessionId = session.sessionId;
      sessionName = session.name ?? null;
      console.log(
        chalk.dim(
          `Continuing session ${formatSessionRef(sessionId, sessionName)}...`,
        ),
      );
    } else {
      // Default: always create a new session
      if (requestedModel) {
        console.log(
          chalk.dim(
            `Creating new session with model ${requestedModel}...`,
          ),
        );
        const result = await createSession(host, { cwd, model: requestedModel });
        sessionId = result.sessionId;
        console.log(
          chalk.dim(`Created session ${sessionId} (${requestedModel})`),
        );
      } else {
        console.log(chalk.dim("Creating new session..."));
        const result = await createSession(host, { cwd });
        sessionId = result.sessionId;
        console.log(
          chalk.dim(`Created session ${sessionId}`),
        );
      }
    }

    if (requestModelAfterConnect && requestedModel) {
      console.log(
        chalk.dim(`Will request model ${requestedModel} after connecting...`),
      );
    }
  } catch (e) {
    console.error(
      chalk.red(
        `Cannot connect to Companion at ${host}. Is it running?`,
      ),
    );
    console.error(chalk.dim(`Start it with: bunx the-companion`));
    process.exit(1);
  }

  // Set up TUI
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const statusBar = new StatusBar();
  const keybindings = AppKeybindingsManager.inMemory();
  const editor = new CustomEditor(tui, editorTheme, keybindings);

  // Set up slash command autocomplete
  const slashCommands = buildAutocompleteSlashCommands();
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(slashCommands),
  );

  // Detect git branch
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      statusBar.gitBranch = proc.stdout.toString().trim();
    }
  } catch {
    // not a git repo or git not available
  }

  // Streaming state
  let streamingText = "";
  let streamingMd: Markdown | null = null;
  let loader: Loader | null = null;
  let permissionBanner: PermissionBanner | null = null;
  let pendingModelSwitch: string | null = null;
  let pendingImages: Array<{ media_type: string; data: string }> = [];
  let modelOptionsCache: Record<BackendType, ModelOption[]> = {
    claude: [...CLAUDE_MODEL_FALLBACKS],
    codex: [...CODEX_MODEL_FALLBACKS],
  };

  // Track whether the current run was triggered by us or by another client (web UI)
  let locallyTriggered = false;

  // Insert a component before the editor (which is always last)
  function insertBeforeEditor(component: Component): void {
    const idx = tui.children.indexOf(editor);
    if (idx >= 0) {
      tui.children.splice(idx, 0, component);
    } else {
      tui.addChild(component);
    }
  }

  function showNotice(message: string): void {
    insertBeforeEditor(new Text(chalk.dim(message), 1, 0));
    insertBeforeEditor(new Spacer(1));
    tui.requestRender();
  }

  function setPendingImages(
    images: Array<{ media_type: string; data: string }>,
  ): void {
    pendingImages = images;
    statusBar.pendingImages = pendingImages.length;
    tui.requestRender();
  }

  async function refreshModelOptionsForBackend(
    backend: BackendType,
  ): Promise<void> {
    try {
      const models = await listBackendModels(host, backend);
      if (models.length > 0) {
        modelOptionsCache[backend] = models.map((m: BackendModelInfo) => ({
          value: m.value,
          label: m.label || m.value,
          description: m.description || "",
        }));
        return;
      }
    } catch {
      // Some backends (e.g. claude) intentionally return 404 and rely on defaults.
    }

    modelOptionsCache[backend] = [...fallbackModelsForBackend(backend)];
  }

  interface PickerOptions {
    title: string;
    items: SelectItem[];
    currentValue?: string;
    onSelect: (value: string) => void;
  }

  function showPicker(options: PickerOptions): void {
    const overlay = new SelectorOverlay(
      options.title,
      options.items,
      Math.min(options.items.length, 10),
      (item) => {
        handle.hide();
        options.onSelect(item.value);
        tui.setFocus(editor);
        tui.requestRender();
      },
      () => {
        handle.hide();
        tui.setFocus(editor);
        tui.requestRender();
      },
    );

    if (options.currentValue) {
      overlay.setSelectedValue(options.currentValue);
    }

    const handle = tui.showOverlay(overlay, {
      anchor: "bottom-center",
      width: "70%",
      minWidth: 44,
      maxHeight: "60%",
      margin: 1,
      offsetY: -1,
    });
  }

  // Remove loader if present
  function removeLoader(): void {
    if (loader) {
      tui.removeChild(loader);
      loader.stop();
      loader = null;
    }
  }

  // Finalize the current streaming markdown block
  function finalizeStream(): void {
    streamingText = "";
    streamingMd = null;
  }

  // Ensure a streaming markdown component exists
  function ensureStreamingMd(): Markdown {
    if (!streamingMd) {
      removeLoader();
      streamingMd = new Markdown("", 1, 0, markdownTheme);
      insertBeforeEditor(streamingMd);
    }
    return streamingMd;
  }

  void refreshModelOptionsForBackend("claude");

  // Handle messages from Companion
  function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "session_init": {
        statusBar.session = msg.session;
        statusBar.cliConnected = true;
        void refreshModelOptionsForBackend(getBackendType(statusBar.session));
        tui.requestRender();
        break;
      }

      case "session_update": {
        if (statusBar.session) {
          Object.assign(statusBar.session, msg.session);
        }
        if (msg.session.backend_type === "claude" || msg.session.backend_type === "codex") {
          void refreshModelOptionsForBackend(msg.session.backend_type);
        }
        if (pendingModelSwitch && msg.session.model) {
          if (msg.session.model === pendingModelSwitch) {
            showNotice(`Model switched to ${chalk.bold(msg.session.model)}.`);
          } else {
            const warning = new Text(
              chalk.yellow(
                `Model switch mismatch: requested ${pendingModelSwitch}, but session reports ${msg.session.model}.`,
              ),
              1,
              0,
            );
            insertBeforeEditor(warning);
            insertBeforeEditor(new Spacer(1));
          }
          pendingModelSwitch = null;
        }
        tui.requestRender();
        break;
      }

      case "user_message": {
        // Skip our own echoes; show messages from other clients
        if (msg.sender_client_id === client.clientId) break;
        // Show messages from other clients (web UI) or history replay
        const label = chalk.magenta("Web: ");
        const userMd = new Markdown(
          label + msg.content,
          1,
          0,
          markdownTheme,
        );
        insertBeforeEditor(userMd);
        insertBeforeEditor(new Spacer(1));
        tui.requestRender();
        break;
      }

      case "assistant": {
        const actualModel = msg.message.model;
        if (statusBar.session && actualModel && statusBar.session.model !== actualModel) {
          statusBar.session.model = actualModel;
        }
        if (pendingModelSwitch) {
          if (actualModel === pendingModelSwitch) {
            showNotice(`Model switched to ${chalk.bold(actualModel)}.`);
          } else {
            const warning = new Text(
              chalk.yellow(
                `Model switch mismatch: requested ${pendingModelSwitch}, but response came from ${actualModel}.`,
              ),
              1,
              0,
            );
            insertBeforeEditor(warning);
            insertBeforeEditor(new Spacer(1));
          }
          pendingModelSwitch = null;
        }

        finalizeStream();
        removeLoader();
        const text = extractText(msg.message.content);
        if (text.trim()) {
          const md = new Markdown(text, 1, 0, markdownTheme);
          insertBeforeEditor(md);
          insertBeforeEditor(new Spacer(1));
        }
        tui.requestRender();
        break;
      }

      case "stream_event": {
        const event = msg.event;
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            const md = ensureStreamingMd();
            streamingText += event.delta.text;
            md.setText(streamingText);
            tui.requestRender();
          } else if (event.delta.type === "thinking_delta") {
            // Could show thinking in a separate component
          }
        } else if (event.type === "content_block_stop") {
          // Block done, but more might come
        } else if (
          event.type === "message_stop" ||
          event.type === "message_delta"
        ) {
          finalizeStream();
        }
        break;
      }

      case "result": {
        finalizeStream();
        removeLoader();
        statusBar.isRunning = false;
        editor.disableSubmit = false;
        locallyTriggered = false;
        if (permissionBanner) {
          tui.removeChild(permissionBanner);
          permissionBanner = null;
          tui.setFocus(editor);
        }

        if (statusBar.session) {
          statusBar.session.total_cost_usd = msg.data.total_cost_usd;
          statusBar.session.num_turns = msg.data.num_turns;
        }

        if (msg.data.is_error && msg.data.errors?.length) {
          const errText = new Text(
            chalk.red(`Error: ${msg.data.errors.join(", ")}`),
            1,
            0,
          );
          insertBeforeEditor(errText);
        }

        insertBeforeEditor(new Spacer(1));
        tui.requestRender();
        break;
      }

      case "permission_request": {
        removeLoader();
        permissionBanner = new PermissionBanner(
          tui,
          msg.request,
          (behavior) => {
            client.sendPermissionResponse(msg.request.request_id, behavior);
            if (permissionBanner) {
              tui.removeChild(permissionBanner);
              permissionBanner = null;
            }
            // Show loader while tool executes
            loader = new Loader(
              tui,
              (s) => chalk.cyan(s),
              (s) => chalk.dim(s),
              `Running ${msg.request.tool_name}...`,
            );
            insertBeforeEditor(loader);
            loader.start();
            tui.setFocus(editor);
            tui.requestRender();
          },
        );
        insertBeforeEditor(permissionBanner);
        tui.setFocus(permissionBanner as unknown as Component);
        tui.requestRender();
        break;
      }

      case "permission_cancelled": {
        if (permissionBanner) {
          tui.removeChild(permissionBanner);
          permissionBanner = null;
          tui.setFocus(editor);
          tui.requestRender();
        }
        break;
      }

      case "tool_progress": {
        if (loader) {
          loader.setMessage(
            `Running ${msg.tool_name}... (${msg.elapsed_time_seconds.toFixed(0)}s)`,
          );
        }
        break;
      }

      case "status_change": {
        const nowRunning = msg.status === "running";
        statusBar.isRunning = nowRunning;

        if (nowRunning && !locallyTriggered) {
          // Another client (web UI) triggered a run
          editor.disableSubmit = true;
          const notice = new Text(
            chalk.dim.italic("  [input from web UI]"),
            0,
            0,
          );
          insertBeforeEditor(notice);
          loader = new Loader(
            tui,
            (s) => chalk.cyan(s),
            (s) => chalk.dim(s),
            "Thinking...",
          );
          insertBeforeEditor(loader);
          loader.start();
        }

        if (msg.status === "compacting") {
          if (loader) loader.setMessage("Compacting context...");
        }
        tui.requestRender();
        break;
      }

      case "cli_disconnected": {
        statusBar.cliConnected = false;
        tui.requestRender();
        break;
      }

      case "cli_connected": {
        statusBar.cliConnected = true;
        tui.requestRender();
        break;
      }

      case "message_history": {
        // Replay history
        for (const histMsg of msg.messages) {
          handleMessage(histMsg);
        }
        break;
      }

      case "event_replay": {
        for (const { msg: replayMsg } of msg.events) {
          handleMessage(replayMsg);
        }
        break;
      }

      case "session_name_update": {
        sessionName = msg.name || null;
        header.setText(formatHeaderTitle(sessionId, sessionName));
        tui.requestRender();
        break;
      }

      case "mcp_status": {
        renderMcpStatus(msg.servers);
        break;
      }

      case "error": {
        const errText = new Text(chalk.red(`Error: ${msg.message}`), 1, 0);
        insertBeforeEditor(errText);
        tui.requestRender();
        break;
      }
    }
  }

  // Build UI tree
  const header = new Text(
    formatHeaderTitle(sessionId, sessionName),
    1,
    0,
  );
  tui.addChild(statusBar);
  tui.addChild(header);
  tui.addChild(new Spacer(1));
  tui.addChild(editor);
  tui.setFocus(editor);

  // Set up Companion WebSocket client
  const client = new CompanionClient({
    host,
    sessionId,
    onMessage: handleMessage,
    onStatusChange: (status) => {
      statusBar.connectionStatus = status;
      if (status !== "connected") {
        statusBar.cliConnected = null;
      }
      if (
        status === "connected" &&
        requestModelAfterConnect &&
        requestedModel &&
        !modelRequestedAfterConnect
      ) {
        modelRequestedAfterConnect = true;
        pendingModelSwitch = requestedModel;
        client.setModel(requestedModel);
        showNotice(`Switching model to ${chalk.bold(requestedModel)}...`);
      }
      tui.requestRender();
    },
  });

  // -- Local slash commands ----------------------------------------------------

  function handleSlashCommand(cmd: string): boolean {
    const parts = cmd.split(/\s+/);
    const name = parts[0]!.toLowerCase();
    const arg = parts.slice(1).join(" ").trim();

    if (name === "/quit" || name === "/exit") {
      cleanup();
      return true;
    }
    if (name === "/clear") {
      clearConversation();
      return true;
    }
    if (name === "/help") {
      showHelp();
      return true;
    }
    if (name === "/mcp") {
      showMcp();
      return true;
    }
    if (name === "/model") {
      showModelPicker(arg || null);
      return true;
    }
    if (name === "/mode") {
      showModePicker(arg || null);
      return true;
    }
    if (name === "/status") {
      showStatus();
      return true;
    }
    // Everything else (e.g. /compact) goes to the CLI as a user message
    return false;
  }

  function clearConversation(): void {
    // Remove everything between the header and the editor
    const keep = new Set<Component>([statusBar, header, editor]);
    const toRemove = tui.children.filter((c) => !keep.has(c));
    for (const c of toRemove) {
      if (c instanceof Loader) c.stop();
      tui.removeChild(c);
    }
    // Re-add spacer between header and editor
    insertBeforeEditor(new Spacer(1));
    tui.requestRender();
  }

  function showHelp(): void {
    const helpText = [
      chalk.bold("Commands:"),
      `  ${chalk.cyan("/help")}          Show this help`,
      `  ${chalk.cyan("/clear")}         Clear conversation display`,
      `  ${chalk.cyan("/quit")}          Exit companion-tui`,
      `  ${chalk.cyan("/compact")}       Compact conversation context`,
      `  ${chalk.cyan("/mcp")}           Show MCP server status`,
      `  ${chalk.cyan("/model [name]")}  Switch model (picker if no arg)`,
      `  ${chalk.cyan("/mode [name]")}   Switch permission mode (picker if no arg)`,
      `  ${chalk.cyan("/status")}        Show session info`,
      "",
      chalk.bold("Keys:"),
      `  ${chalk.cyan("Esc")}            Interrupt current operation`,
      `  ${chalk.cyan("Ctrl+C")}         Interrupt, clear input, or exit if empty (2x to force)`,
      `  ${chalk.cyan("Ctrl+G")}         Edit prompt in $EDITOR (vim fallback)`,
      `  ${chalk.cyan("Ctrl+V")}         Attach clipboard image`,
      `  ${chalk.cyan("Ctrl+L")}         Open model picker`,
      `  ${chalk.cyan("Ctrl+P")}         Cycle model forward`,
      `  ${chalk.cyan("Ctrl+Shift+P")}   Cycle model backward`,
      `  ${chalk.cyan("Enter")}          Send message`,
      "",
      chalk.dim("Other slash commands are forwarded to the Claude Code CLI."),
    ].join("\n");
    const helpMd = new Text(helpText, 1, 0);
    insertBeforeEditor(helpMd);
    insertBeforeEditor(new Spacer(1));
    tui.requestRender();
  }

  // -- /mcp command -----------------------------------------------------------

  // Tracks the last MCP status response for interactive toggle/reconnect
  let lastMcpServers: McpServerDetail[] = [];

  function showMcp(): void {
    client.mcpGetStatus();
    const notice = new Text(chalk.dim("Fetching MCP server status..."), 1, 0);
    insertBeforeEditor(notice);
    tui.requestRender();
  }

  function renderMcpStatus(servers: McpServerDetail[]): void {
    lastMcpServers = servers;
    if (servers.length === 0) {
      const notice = new Text(chalk.dim("No MCP servers configured."), 1, 0);
      insertBeforeEditor(notice);
      insertBeforeEditor(new Spacer(1));
      tui.requestRender();
      return;
    }

    const lines: string[] = [chalk.bold("MCP Servers:")];
    for (let i = 0; i < servers.length; i++) {
      const s = servers[i]!;
      const dot =
        s.status === "connected"
          ? chalk.green("●")
          : s.status === "connecting"
            ? chalk.yellow("●")
            : s.status === "disabled"
              ? chalk.dim("○")
              : chalk.red("●");
      const toolCount = s.tools?.length ?? 0;
      const toolsLabel = toolCount > 0 ? chalk.dim(` (${toolCount} tools)`) : "";
      lines.push(
        `  ${chalk.dim(`${i + 1}.`)} ${dot} ${chalk.bold(s.name)} ${chalk.dim(s.config.type)}${toolsLabel}`,
      );
      if (s.error) {
        lines.push(`     ${chalk.red(s.error)}`);
      }
    }
    lines.push("");
    lines.push(
      chalk.dim(
        "  Type number + t to toggle, number + r to reconnect (e.g. 1t, 2r)",
      ),
    );

    const mcpText = new Text(lines.join("\n"), 1, 0);
    insertBeforeEditor(mcpText);
    insertBeforeEditor(new Spacer(1));
    tui.requestRender();
  }

  // -- /model command --------------------------------------------------------

  function setModel(model: string): void {
    const normalized = parseModelInput(model);
    if (!normalized) {
      showNotice("Model name cannot be empty.");
      return;
    }
    pendingModelSwitch = normalized;
    client.setModel(normalized);
    showNotice(`Switching model to ${chalk.bold(normalized)}...`);
  }

  function cycleModel(direction: "forward" | "backward"): void {
    void (async () => {
      const backend = getBackendType(statusBar.session);
      await refreshModelOptionsForBackend(backend);
      const options = modelOptionsCache[backend];

      if (options.length === 0) {
        showNotice(`No models available for backend ${backend}.`);
        return;
      }

      const currentModel = statusBar.session?.model;
      const currentIndex = options.findIndex((m) => m.value === currentModel);
      let nextIndex: number;

      if (currentIndex < 0) {
        nextIndex = direction === "forward" ? 0 : options.length - 1;
      } else if (direction === "forward") {
        nextIndex = (currentIndex + 1) % options.length;
      } else {
        nextIndex = (currentIndex - 1 + options.length) % options.length;
      }

      const next = options[nextIndex];
      if (!next) return;
      setModel(next.value);
    })();
  }

  function showModelPicker(directArg: string | null): void {
    if (directArg) {
      setModel(directArg);
      return;
    }

    void (async () => {
      const backend = getBackendType(statusBar.session);
      await refreshModelOptionsForBackend(backend);
      const items: SelectItem[] = modelOptionsCache[backend].map((m) => ({
        label: m.label,
        value: m.value,
        description: m.description,
      }));

      if (items.length === 0) {
        showNotice(`No models available for backend ${backend}.`);
        return;
      }

      showPicker({
        title: `Select model (${backend})`,
        items,
        currentValue: statusBar.session?.model,
        onSelect: (value) => setModel(value),
      });
    })();
  }

  // -- /mode command ---------------------------------------------------------

  function setPermissionMode(mode: string): void {
    client.setPermissionMode(mode);
    showNotice(`Switching permission mode to ${chalk.bold(mode)}...`);
  }

  function showModePicker(directArg: string | null): void {
    if (directArg) {
      setPermissionMode(directArg);
      return;
    }

    const items = fallbackModesForBackend(getBackendType(statusBar.session));

    showPicker({
      title: "Select permission mode",
      items,
      currentValue: statusBar.session?.permissionMode,
      onSelect: (value) => setPermissionMode(value),
    });
  }

  // -- /status command -------------------------------------------------------

  function showStatus(): void {
    const s = statusBar.session;
    if (!s) {
      const notice = new Text(
        chalk.dim("No session info available yet."),
        1,
        0,
      );
      insertBeforeEditor(notice);
      insertBeforeEditor(new Spacer(1));
      tui.requestRender();
      return;
    }

    const lines: string[] = [chalk.bold("Session Status:")];
    lines.push(`  Session ID:  ${chalk.dim(sessionId)}`);
    if (sessionName) {
      lines.push(`  Name:        ${chalk.bold(sessionName)}`);
    }
    lines.push(`  Model:       ${chalk.cyan(s.model)}`);
    lines.push(`  Mode:        ${chalk.magenta(s.permissionMode)}`);
    lines.push(`  Cost:        ${chalk.yellow(`$${s.total_cost_usd.toFixed(4)}`)}`);
    lines.push(`  Context:     ${s.context_used_percent}%`);
    lines.push(`  Turns:       ${s.num_turns}`);
    lines.push(`  CWD:         ${chalk.dim(s.cwd)}`);
    if (statusBar.gitBranch) {
      lines.push(`  Git branch:  ${chalk.dim(statusBar.gitBranch)}`);
    }
    if (s.mcp_servers.length > 0) {
      lines.push(`  MCP servers: ${s.mcp_servers.length}`);
    }
    lines.push(`  Version:     ${chalk.dim(s.claude_code_version)}`);

    const statusText = new Text(lines.join("\n"), 1, 0);
    insertBeforeEditor(statusText);
    insertBeforeEditor(new Spacer(1));
    tui.requestRender();
  }

  function cleanup(): void {
    client.dispose();
    tui.stop();
    process.exit(0);
  }

  // Wire up editor submit
  editor.onSubmit = (text: string) => {
    const trimmed = text.trim();
    const outgoingImages = pendingImages.length > 0 ? [...pendingImages] : [];
    if (!trimmed && outgoingImages.length === 0) return;

    // Handle local slash commands
    if (trimmed.startsWith("/") && handleSlashCommand(trimmed)) {
      return;
    }

    // Handle MCP toggle/reconnect (e.g. "1t", "2r")
    const mcpAction = trimmed.match(/^(\d+)([tr])$/i);
    if (mcpAction && lastMcpServers.length > 0) {
      const idx = parseInt(mcpAction[1]!, 10) - 1;
      const action = mcpAction[2]!.toLowerCase();
      const server = lastMcpServers[idx];
      if (server) {
        if (action === "t") {
          const nowEnabled = server.status !== "disabled";
          client.mcpToggle(server.name, !nowEnabled);
          const verb = nowEnabled ? "Disabling" : "Enabling";
          const notice = new Text(
            chalk.dim(`${verb} ${chalk.bold(server.name)}...`),
            1,
            0,
          );
          insertBeforeEditor(notice);
          // Refresh status after a short delay
          setTimeout(() => client.mcpGetStatus(), 500);
        } else {
          client.mcpReconnect(server.name);
          const notice = new Text(
            chalk.dim(`Reconnecting ${chalk.bold(server.name)}...`),
            1,
            0,
          );
          insertBeforeEditor(notice);
          setTimeout(() => client.mcpGetStatus(), 1000);
        }
        tui.requestRender();
        return;
      }
    }

    if (statusBar.isRunning) return;

    // Send to Companion
    locallyTriggered = true;
    client.sendUserMessage(trimmed, outgoingImages.length > 0 ? outgoingImages : undefined);
    if (outgoingImages.length > 0) {
      setPendingImages([]);
    }

    // Show user message in TUI
    const imageSuffix =
      outgoingImages.length > 0
        ? chalk.dim(
            `  [${outgoingImages.length} image${outgoingImages.length === 1 ? "" : "s"}]`,
          )
        : "";
    const visibleText = trimmed || chalk.dim("[image message]");
    const userMd = new Markdown(
      chalk.blue("You: ") + visibleText + imageSuffix,
      1,
      0,
      markdownTheme,
    );
    insertBeforeEditor(userMd);

    // Show loader
    statusBar.isRunning = true;
    editor.disableSubmit = true;
    loader = new Loader(
      tui,
      (s) => chalk.cyan(s),
      (s) => chalk.dim(s),
      "Thinking...",
    );
    insertBeforeEditor(loader);
    loader.start();
    tui.requestRender();
  };

  // Global keybindings
  let lastCtrlC = 0;

  function openPromptInExternalEditor(): void {
    if (statusBar.isRunning) {
      showNotice("Cannot open external editor while a run is in progress.");
      return;
    }

    const shell = process.env.SHELL || "/bin/sh";
    const editorCmd = process.env.VISUAL || process.env.EDITOR || "vim";
    const initial = editor.getExpandedText();
    const tmpDir = mkdtempSync(join(tmpdir(), "companion-tui-"));
    const tmpFile = join(tmpDir, "prompt.md");
    let tuiStopped = false;

    const shellQuote = (value: string): string =>
      `'${value.replace(/'/g, `'\\''`)}'`;

    try {
      writeFileSync(tmpFile, initial, "utf8");
      tui.stop();
      tuiStopped = true;

      const command = `${editorCmd} ${shellQuote(tmpFile)}`;
      const proc = Bun.spawnSync([shell, "-lc", command], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });

      if (tuiStopped) {
        tui.start();
        tuiStopped = false;
      }
      tui.setFocus(editor);
      tui.requestRender(true);

      if (proc.exitCode !== 0) {
        showNotice(
          `External editor exited with code ${proc.exitCode}. Prompt not changed.`,
        );
        return;
      }

      const edited = readFileSync(tmpFile, "utf8").replace(/\r\n/g, "\n");
      editor.setText(edited);
      showNotice("Prompt updated from external editor.");
    } catch (error) {
      if (tuiStopped) {
        tui.start();
      }
      tui.setFocus(editor);
      tui.requestRender(true);
      const message = error instanceof Error ? error.message : String(error);
      showNotice(`Failed to open external editor: ${message}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  async function attachClipboardImage(): Promise<void> {
    if (statusBar.isRunning) {
      showNotice("Cannot attach an image while a run is in progress.");
      return;
    }

    try {
      const image = await readClipboardImage();
      if (!image) {
        showNotice("No image found in clipboard.");
        return;
      }

      const mediaType = normalizeMimeType(image.mimeType);
      const data = Buffer.from(image.bytes).toString("base64");
      setPendingImages([...pendingImages, { media_type: mediaType, data }]);

      const imageLabel = pendingImages.length === 1 ? "image" : "images";
      showNotice(`${pendingImages.length} ${imageLabel} attached.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showNotice(`Failed to read clipboard image: ${message}`);
    }
  }

  editor.onAction("selectModel", () => {
    if (statusBar.isRunning) {
      showNotice("Cannot switch model while a run is in progress.");
      return;
    }
    showModelPicker(null);
  });
  editor.onAction("cycleModelForward", () => {
    if (statusBar.isRunning) {
      showNotice("Cannot switch model while a run is in progress.");
      return;
    }
    cycleModel("forward");
  });
  editor.onAction("cycleModelBackward", () => {
    if (statusBar.isRunning) {
      showNotice("Cannot switch model while a run is in progress.");
      return;
    }
    cycleModel("backward");
  });
  editor.onAction("externalEditor", () => {
    openPromptInExternalEditor();
  });
  editor.onPasteImage = () => {
    void attachClipboardImage();
  };

  tui.addInputListener((data) => {
    // ESC: interrupt if running
    if (matchesKey(data, "escape")) {
      if (statusBar.isRunning) {
        client.interrupt();
        return { consume: true };
      }
      return undefined; // let editor handle it (e.g. close autocomplete)
    }

    // Ctrl+C: interrupt if running, otherwise clear input first and exit if already empty
    if (matchesKey(data, "ctrl+c")) {
      const now = Date.now();
      if (statusBar.isRunning) {
        // Double Ctrl+C within 500ms: force exit even while running
        if (now - lastCtrlC < 500) {
          cleanup();
        }
        lastCtrlC = now;
        client.interrupt();
        return { consume: true };
      }
      if (editor.getText().length > 0) {
        editor.setText("");
        tui.requestRender();
        return { consume: true };
      }
      cleanup();
      return { consume: true };
    }
    return undefined;
  });

  // Connect and start
  client.connect();
  tui.start();
}

main().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
