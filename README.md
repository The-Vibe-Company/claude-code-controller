<p align="center">
  <img src="screenshot.png" alt="The Vibe Companion" width="100%" />
</p>

<h1 align="center">The Vibe Companion</h1>

<p align="center">
  <strong>An open-source web interface for Claude Code, built on an undocumented WebSocket protocol we reverse-engineered from the CLI.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/the-vibe-companion"><img src="https://img.shields.io/npm/v/the-vibe-companion.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/the-vibe-companion"><img src="https://img.shields.io/npm/dm/the-vibe-companion.svg" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://github.com/The-Vibe-Company/claude-code-controller/stargazers"><img src="https://img.shields.io/github/stars/The-Vibe-Company/claude-code-controller.svg?style=social" alt="GitHub Stars" /></a>
</p>

<br />

> Launch Claude Code sessions from your browser. Stream responses in real-time. Approve tool calls. Monitor multiple agents. No API key needed &mdash; uses your existing Claude Code subscription.

<br />

## Quick Start

> **Prerequisite:** [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

```bash
bunx the-vibe-companion
```

That's it. Open [http://localhost:3456](http://localhost:3456) and start coding.

You can also use the shorter alias:

```bash
bunx vibe
```

<br />

---

<br />

## Features

**Multi-session management** &mdash; Launch multiple Claude Code sessions and switch between them. Each session runs in its own process with independent state, model, and permission settings.

**Real-time streaming** &mdash; Watch responses generate token by token over WebSocket. See elapsed time and output token count as the agent works.

**Tool call visualization** &mdash; Every tool call (Bash, Read, Edit, Write, Glob, Grep, WebSearch...) is displayed in collapsible blocks with syntax-highlighted content. See exactly what your agent is doing.

**Interactive permission control** &mdash; Approve, deny, or edit tool inputs before they execute. Choose your permission mode per session: bypass all, accept edits, plan-only, or full manual control.

**Subagent task nesting** &mdash; When agents spawn sub-agents via the Task tool, their work renders nested under the parent with collapsed previews and a dedicated task panel.

**Live session stats** &mdash; Track cost (USD), context window usage, and turn count in real-time. A color-coded progress bar warns you as context fills up.

**Slash commands & image attachments** &mdash; Use `/` to access commands and skills with autocomplete. Paste or upload images directly into your messages.

**Dark mode** &mdash; Toggle between light and dark themes. Your preference persists across sessions.

<br />

---

<br />

## How It Works

Claude Code CLI has a **hidden `--sdk-url` flag** that makes it connect to an external WebSocket server instead of running in a terminal. We reverse-engineered the NDJSON protocol it speaks and built a web server that bridges it to your browser.

```
                     WebSocket (NDJSON)              WebSocket (JSON)
┌──────────────┐    /ws/cli/:session         ┌─────────────────┐    /ws/browser/:session    ┌─────────────┐
│  Claude Code │ ◄──────────────────────────► │   Bun + Hono    │ ◄────────────────────────► │   Browser   │
│     CLI      │                              │     Server      │                            │  (React)    │
└──────────────┘                              └─────────────────┘                            └─────────────┘
                                               │
                                               ├─ Spawns CLI processes
                                               ├─ Routes messages bidirectionally
                                               ├─ Manages permission flow
                                               └─ Tracks session state & history
```

**The flow:**

1. You type a prompt in the browser
2. The server spawns `claude --sdk-url ws://localhost:3456/ws/cli/SESSION_ID --print --output-format stream-json`
3. The CLI connects back to the server over WebSocket
4. Messages flow both ways: your prompts go to the CLI, streaming responses come back to your browser
5. When the CLI wants to run a tool, it sends a permission request &mdash; the server forwards it to your browser for approval

<br />

---

<br />

## The Protocol

This project exists because we found something interesting buried in the Claude Code CLI binary: a hidden `--sdk-url` flag (`.hideHelp()` in Commander) that switches the CLI from terminal mode to WebSocket client mode.

The protocol it speaks is **NDJSON** (newline-delimited JSON) &mdash; the same format used internally by the official `@anthropic-ai/claude-agent-sdk`. We reverse-engineered the full specification:

- **13 control request subtypes** (initialize, can_use_tool, interrupt, set_model, MCP operations, and more)
- **Permission flow** for tool approval/denial with input editing
- **Streaming events** for token-by-token response delivery
- **Session lifecycle** management and reconnection logic

The complete protocol specification is documented in [`WEBSOCKET_PROTOCOL_REVERSED.md`](WEBSOCKET_PROTOCOL_REVERSED.md).

<br />

---

<br />

## Development

```bash
git clone https://github.com/The-Vibe-Company/claude-code-controller.git
cd claude-code-controller/web
bun install
bun run dev          # server on :3456 + Vite on :5174
```

Open [http://localhost:5174](http://localhost:5174) for hot-reloading development.

For production builds:

```bash
bun run build && bun run start   # everything on :3456
```

<br />

---

<br />

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh) |
| Server | [Hono](https://hono.dev) + native Bun WebSocket |
| Frontend | [React 19](https://react.dev) + [TypeScript](https://www.typescriptlang.org) |
| State | [Zustand](https://github.com/pmndrs/zustand) |
| Styling | [Tailwind CSS v4](https://tailwindcss.com) |
| Build | [Vite](https://vite.dev) |

<br />

---

<br />

## Roadmap

The Vibe Companion started as a way to control Claude Code from the browser. But the vision is bigger:

**An open-source web interface for AI coding agents, compatible with any LLM provider.**

What's coming:

- Support for additional LLM providers beyond Anthropic
- Bring-your-own-API-key mode
- Collaborative multi-user sessions
- Plugin system for custom tool integrations
- Self-hosted deployment with Docker

If you want to help shape the future of AI-assisted development, contributions are welcome.

<br />

---

<br />

## License

MIT &copy; [The Vibe Company](https://github.com/The-Vibe-Company)
