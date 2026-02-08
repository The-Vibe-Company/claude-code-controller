<p align="center">
  <h1 align="center">claude-code-controller</h1>
  <p align="center">
    <strong>Spawn, orchestrate, and control Claude Code agents — programmatically.</strong>
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/claude-code-controller"><img src="https://img.shields.io/npm/v/claude-code-controller" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node >= 18" /></a>
  </p>
</p>

<br />

<p align="center">
  <img src="screenshot.png" alt="Claude Code Controller — Web Dashboard" width="100%" />
</p>

<br />

> Control real Claude Code instances through a **REST API**, a **TypeScript SDK**, or a **Web Dashboard**.
> Spawn agents, send them messages, assign tasks, approve plans — from your code or your browser.

<br />

---

<br />

## Why this instead of the Agent SDK?

This runs **real Claude Code processes**. Not a wrapper around the API. Not a simplified `-p` mode. Actual Claude Code — the same one you use in your terminal every day.

That means:

- **Uses your Claude Code subscription** — No separate API key. No usage-based billing surprise. If you have a Max plan, your agents run on it.
- **Day 0 features** — When Anthropic ships a new Claude Code feature (new tools, new models, better context handling), you get it immediately. No library update needed. No waiting for SDK support.
- **Full tool access** — Bash, Read, Write, Edit, Glob, Grep, WebSearch, Task sub-agents... everything Claude Code can do, your agents can do.
- **Real terminal environment** — Agents run in a PTY. They can install packages, run tests, use git, call APIs. They work in your actual project directory.
- **Battle-tested agent loop** — Claude Code's agent loop is production-hardened. You get all of that for free: retries, error handling, tool orchestration, context management.

<br />

---

<br />

## What you can do

**Spawn multiple agents on the same codebase**, each with a different role. One reviews security, another writes tests, another refactors — all in parallel, all through a simple API.

```bash
# Spawn an agent via the REST API
curl -X POST http://localhost:3000/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "security-reviewer", "model": "opus"}'

# Give it work
curl -X POST http://localhost:3000/agents/security-reviewer/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "Audit src/auth/ for vulnerabilities. Reply with SendMessage."}'
```

**Build automation on top of Claude Code.** A webhook that triggers a code fix when CI fails. A Slack bot that assigns tasks to agents. A cron job that runs nightly code reviews. If you can make an HTTP call, you can control Claude Code.

**Monitor and control agents from a web dashboard.** See what each agent is doing, approve or reject their plans, grant tool permissions, kill runaway agents — all in real-time from your browser.

**Manage work with tasks.** Create tasks, assign them to agents, track progress, define dependencies between tasks. Agents pick up their assignments and report back when done.

```typescript
const taskId = await ctrl.createTask({
  subject: "Add input validation to all API routes",
  description: "Use zod schemas for request body validation in src/routes/",
});
await ctrl.assignTask(taskId, "coder");
await ctrl.waitForTask(taskId); // blocks until done
```

<br />

---

<br />

## Features

- **REST API** — Control everything over HTTP. Spawn agents, send messages, manage tasks. Works from any language, any platform.
- **TypeScript SDK** — Full programmatic control with type safety and an event-driven architecture.
- **Web Dashboard** — Real-time monitoring, agent management, and interactive approvals from your browser.
- **Multi-Agent** — Run multiple agents in parallel, each with their own role, model, and permissions.
- **Task Management** — Create tasks, assign them, track status, define blocking dependencies.
- **Plan & Permission Approval** — Agents ask before acting. You approve or reject — programmatically or from the UI.
- **Any Provider** — Point agents at any Anthropic-compatible endpoint. Per-agent environment and API key overrides.
- **Your Subscription** — Runs on your existing Claude Code plan. No separate API costs.

<br />

---

<br />

## Install

```bash
npm install claude-code-controller
```

> **Prerequisite:** [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) v2.1.34+

<br />

---

<br />

## Quick Start — 30 seconds to your first agent

```typescript
import { ClaudeCodeController } from "claude-code-controller";

const ctrl = new ClaudeCodeController({ teamName: "my-project" });
await ctrl.init();

const agent = await ctrl.spawnAgent({
  name: "coder",
  model: "sonnet",
});

await new Promise((r) => setTimeout(r, 10_000));

const answer = await agent.ask(
  "Read package.json and tell me the project name. Reply using SendMessage.",
  { timeout: 60_000 }
);
console.log(answer);

await ctrl.shutdown();
```

<br />

---

<br />

## REST API

The API lets you control Claude Code agents from **any language, any platform** — just HTTP.

Start a server in a few lines:

```typescript
import { createApi } from "claude-code-controller/api";
import { serve } from "bun"; // or any Hono-compatible runtime

const app = createApi(); // lazy mode — init via POST /session/init
serve({ port: 3000, fetch: app.fetch.bind(app) });
```

Or attach to an existing controller:

```typescript
import { ClaudeCodeController } from "claude-code-controller";
import { createApi } from "claude-code-controller/api";

const ctrl = new ClaudeCodeController({ teamName: "my-team" });
await ctrl.init();

const app = createApi(ctrl); // pre-initialized mode
```

<br />

### Endpoints

#### Session

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health & uptime |
| `GET` | `/session` | Current session info |
| `POST` | `/session/init` | Initialize a new controller session |
| `POST` | `/session/shutdown` | Shut down the controller |

#### Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/agents` | List all agents |
| `POST` | `/agents` | Spawn a new agent |
| `GET` | `/agents/:name` | Get agent details |
| `POST` | `/agents/:name/messages` | Send a message to an agent |
| `POST` | `/agents/:name/kill` | Force-kill an agent |
| `POST` | `/agents/:name/shutdown` | Request graceful shutdown |
| `POST` | `/agents/:name/approve-plan` | Approve or reject a plan |
| `POST` | `/agents/:name/approve-permission` | Approve or deny tool use |

#### Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/tasks` | List all tasks |
| `POST` | `/tasks` | Create a new task |
| `GET` | `/tasks/:id` | Get task details |
| `PATCH` | `/tasks/:id` | Update a task |
| `DELETE` | `/tasks/:id` | Delete a task |
| `POST` | `/tasks/:id/assign` | Assign task to an agent |

#### Actions (for dashboards & UIs)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/actions` | All pending actions (approvals, idle agents, unassigned tasks) |
| `GET` | `/actions/approvals` | Pending approval requests |
| `GET` | `/actions/tasks` | Unassigned tasks |
| `GET` | `/actions/idle-agents` | Idle agents waiting for work |

#### Broadcasting

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/broadcast` | Send a message to all agents |

<br />

### API Examples

**Initialize a session:**

```bash
curl -X POST http://localhost:3000/session/init \
  -H "Content-Type: application/json" \
  -d '{"teamName": "my-team", "cwd": "/path/to/project", "claudeDir": "/path/to/.claude"}'
```

**Spawn an agent:**

```bash
curl -X POST http://localhost:3000/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "reviewer",
    "type": "general-purpose",
    "model": "sonnet",
    "permissions": ["Bash", "Read", "Write"]
  }'
```

**Send a message:**

```bash
curl -X POST http://localhost:3000/agents/reviewer/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "Review src/auth.ts for security vulnerabilities. Reply with SendMessage."}'
```

**Create and assign a task:**

```bash
# Create
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"subject": "Fix login bug", "description": "Users cannot login with SSO"}'

# Assign
curl -X POST http://localhost:3000/tasks/1/assign \
  -H "Content-Type: application/json" \
  -d '{"agent": "reviewer"}'
```

**Check pending actions:**

```bash
curl http://localhost:3000/actions
# → { "pending": 2, "approvals": [...], "unassignedTasks": [...], "idleAgents": [...] }
```

<br />

---

<br />

## TypeScript SDK

The SDK gives you full programmatic control with type safety and an event-driven architecture.

### Controller

```typescript
import { ClaudeCodeController } from "claude-code-controller";

const ctrl = new ClaudeCodeController({
  teamName: "my-team",        // auto-generated if omitted
  cwd: "/path/to/project",    // working directory for agents
  claudeDir: "/path/to/.claude", // where teams/inboxes/tasks live (default: ~/.claude)
  claudeBinary: "claude",     // path to CLI binary
  env: {                      // default env vars for all agents
    ANTHROPIC_BASE_URL: "https://your-proxy.example.com",
  },
  logLevel: "info",           // "debug" | "info" | "warn" | "error" | "silent"
});

await ctrl.init();
// ... use the controller ...
await ctrl.shutdown();
```

### Spawning Agents

```typescript
const agent = await ctrl.spawnAgent({
  name: "coder",
  type: "general-purpose",   // "general-purpose" | "Bash" | "Explore" | "Plan"
  model: "sonnet",           // "sonnet" | "opus" | "haiku" | full model ID
  cwd: "/specific/directory",
  permissions: ["Bash", "Read", "Write", "Glob", "Grep"],
  env: { MY_VAR: "value" },  // per-agent env overrides
});
```

### AgentHandle

Every spawned agent returns an `AgentHandle` — a convenient wrapper for interacting with it.

```typescript
// Send and receive
await agent.send("Analyze the codebase structure.");
const response = await agent.receive({ timeout: 30_000 });

// Or use ask() for send + receive in one call
const answer = await agent.ask("What framework is this project using?", {
  timeout: 60_000,
});

// Stream events
for await (const msg of agent.events()) {
  console.log(`[${agent.name}]`, msg.text);
}

// Lifecycle
agent.isRunning;    // boolean
agent.pid;          // process ID
await agent.shutdown();  // graceful
await agent.kill();      // force
```

### Messaging

```typescript
// Direct messaging
await ctrl.send("agent-name", "Your instructions here", "optional summary");

// Broadcast to all agents
await ctrl.broadcast("Everyone stop and report status.");

// Wait for a response
const messages = await ctrl.receive("agent-name", {
  timeout: 60_000,
  pollInterval: 500,
  all: true,          // get all unread messages
});

// Wait for any agent to respond
const msg = await ctrl.receiveAny({ timeout: 30_000 });
```

### Task Management

```typescript
// Create a task
const taskId = await ctrl.createTask({
  subject: "Add input validation",
  description: "Add zod schemas to all API endpoints in src/routes/",
  owner: "coder",           // optional — assign immediately
  metadata: { priority: "high" },
});

// Assign later
await ctrl.assignTask(taskId, "coder");

// Wait for completion
const task = await ctrl.waitForTask(taskId, 120_000);
console.log(task.status); // "completed"
```

### Events

```typescript
// Agent messages
ctrl.on("message", (agentName, message) => {
  console.log(`[${agentName}] ${message.text}`);
});

// Plan approval — agent wants to execute a plan
ctrl.on("plan:approval_request", (agentName, msg) => {
  console.log(`${agentName} wants to execute a plan:`, msg.planContent);
  ctrl.sendPlanApproval(agentName, msg.requestId, true);
});

// Permission request — agent wants to use a tool
ctrl.on("permission:request", (agentName, msg) => {
  const safe = ["Read", "Glob", "Grep"].includes(msg.toolName);
  ctrl.sendPermissionResponse(agentName, msg.requestId, safe);
});

// Lifecycle events
ctrl.on("agent:spawned", (name, pid) => console.log(`${name} started (pid: ${pid})`));
ctrl.on("agent:exited", (name, code) => console.log(`${name} exited (code: ${code})`));
ctrl.on("idle", (name) => console.log(`${name} is idle`));
ctrl.on("task:completed", (task) => console.log(`Task done: ${task.subject}`));
ctrl.on("error", (err) => console.error("Controller error:", err));
```

<br />

---

<br />

## Real-World Examples

### Parallel Code Review

```typescript
const ctrl = new ClaudeCodeController({ teamName: "review" });
await ctrl.init();

const [security, perf, style] = await Promise.all([
  ctrl.spawnAgent({ name: "security", model: "opus" }),
  ctrl.spawnAgent({ name: "perf", model: "sonnet" }),
  ctrl.spawnAgent({ name: "style", model: "haiku" }),
]);

await new Promise((r) => setTimeout(r, 12_000));

const reviews = await Promise.all([
  security.ask("Review src/ for security vulnerabilities. Reply with SendMessage."),
  perf.ask("Review src/ for performance issues. Reply with SendMessage."),
  style.ask("Review src/ for code style issues. Reply with SendMessage."),
]);

console.log("Security:", reviews[0]);
console.log("Performance:", reviews[1]);
console.log("Style:", reviews[2]);

await ctrl.shutdown();
```

### Task-Based Workflow

```typescript
const ctrl = new ClaudeCodeController({ teamName: "tasks" });
await ctrl.init();

const worker = await ctrl.spawnAgent({ name: "worker", model: "sonnet" });
await new Promise((r) => setTimeout(r, 10_000));

const taskId = await ctrl.createTask({
  subject: "Add input validation",
  description: "Add zod validation to all API route handlers in src/routes/",
  owner: "worker",
});

const result = await ctrl.waitForTask(taskId, 120_000);
console.log(`Task ${result.status}: ${result.subject}`);

await ctrl.shutdown();
```

### Custom API Provider

```typescript
const ctrl = new ClaudeCodeController({
  teamName: "custom",
  env: {
    ANTHROPIC_BASE_URL: "https://your-proxy.example.com/api/anthropic",
    ANTHROPIC_AUTH_TOKEN: process.env.MY_API_KEY!,
  },
});

// Per-agent overrides
const agent = await ctrl.spawnAgent({
  name: "worker",
  env: { ANTHROPIC_AUTH_TOKEN: "different-key-for-this-agent" },
});
```

### Auto-Approve Everything (YOLO mode)

```typescript
ctrl.on("plan:approval_request", (agent, msg) => {
  ctrl.sendPlanApproval(agent, msg.requestId, true);
});

ctrl.on("permission:request", (agent, msg) => {
  ctrl.sendPermissionResponse(agent, msg.requestId, true);
});
```

### Selective Permission Control

```typescript
const SAFE_TOOLS = ["Read", "Glob", "Grep", "Task"];
const NEEDS_REVIEW = ["Bash", "Write", "Edit"];

ctrl.on("permission:request", (agent, msg) => {
  if (SAFE_TOOLS.includes(msg.toolName)) {
    ctrl.sendPermissionResponse(agent, msg.requestId, true);
  } else if (NEEDS_REVIEW.includes(msg.toolName)) {
    console.log(`[REVIEW] ${agent} wants to use ${msg.toolName}: ${msg.description}`);
    // Implement your own review logic here
    ctrl.sendPermissionResponse(agent, msg.requestId, true);
  } else {
    ctrl.sendPermissionResponse(agent, msg.requestId, false);
  }
});
```

<br />

---

<br />

## Web Dashboard

A built-in web UI for real-time agent management — no code required.

```bash
cd web && bun install
```

**Development:**

```bash
bun run dev          # backend on :3456
bun run dev:vite     # frontend on :5174
```

**Production:**

```bash
bun run build && bun run start   # everything on :3456
```

The dashboard gives you:

- **Session management** — Initialize and shut down the controller
- **Agent spawning** — Configure name, type, model, and environment variables
- **Live message feed** — Real-time messages via WebSocket
- **Approval prompts** — Interactive plan and permission approval banners
- **Agent controls** — Shutdown or kill agents individually

<br />

---

<br />

## How It Works

Claude Code has an internal "teammate" protocol that uses the filesystem for communication. This library creates the required files, spawns real Claude Code CLI processes via PTY, and communicates with them through inbox files. Agents think they're in a normal team and behave naturally.

```
~/.claude/
├── teams/{teamName}/
│   ├── config.json                    # Team membership & config
│   └── inboxes/
│       ├── controller.json            # Messages TO controller FROM agents
│       ├── agent-1.json               # Messages TO agent-1 FROM controller
│       └── agent-2.json               # Messages TO agent-2 FROM controller
└── tasks/{teamName}/
    ├── 1.json                         # Task files
    └── 2.json
```

**Architecture:**

```
ClaudeCodeController
├── TeamManager        → Team config CRUD
├── TaskManager        → Task lifecycle management
├── ProcessManager     → PTY-based process spawning
├── InboxPoller        → Polls controller inbox for agent messages
└── AgentHandle[]      → Per-agent convenience wrappers
```

**The flow:**

1. **Spawn** — Calls `claude --teammate-mode auto --agent-id name@team ...` via a PTY wrapper
2. **Register** — Agent is registered in the team config with its role, model, and permissions
3. **Communicate** — Controller writes to `inboxes/{agent}.json`, agent writes to `inboxes/controller.json`
4. **Poll** — InboxPoller reads the controller inbox every 500ms and fires events
5. **Lock** — All file operations use `proper-lockfile` to prevent corruption from concurrent access

<br />

---

<br />

## Development

```bash
bun install          # install deps
bun test             # run tests (89 tests)
bun run typecheck    # type check
bun run build        # build for distribution
```

<br />

---

<br />

## Roadmap

- **Tmux session per agent** — Spawn each agent in its own tmux pane. Attach with `tmux attach -t <agent>` and watch it work: tool calls, file edits, reasoning — like watching someone use Claude Code interactively.
- **Task management in the UI** — Create, assign, and track tasks from the web dashboard.
- **Agent-to-agent messaging** — Let agents communicate directly with each other.
- **Persistent sessions** — Resume a team session after server restart.

<br />

---

<br />

## License

MIT
