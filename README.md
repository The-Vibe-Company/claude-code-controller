<p align="center">
  <img src="screenshot.png" alt="The Companion" width="100%" />
</p>

<h1 align="center">The Companion</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/the-companion"><img src="https://img.shields.io/npm/v/the-companion.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/the-companion"><img src="https://img.shields.io/npm/dm/the-companion.svg" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
</p>

<br />

Claude Code in your browser. We reverse-engineered the undocumented WebSocket protocol hidden inside the CLI and built a web UI on top of it. No API key needed, it runs on your existing Claude Code subscription.

```bash
bunx the-companion
```

Open [localhost:3456](http://localhost:3456). That's it.

Foreground mode is also available explicitly with:

```bash
the-companion serve
```

## Why

Claude Code is powerful but stuck in a terminal. You can't easily run multiple sessions, there's no visual feedback on tool calls, and if the process dies your context is gone.

The Companion fixes that. It spawns Claude Code processes, streams their output to your browser in real-time, and lets you approve or deny tool calls from a proper UI.

## What you get

- **Multiple sessions.** Run several Claude Code instances side by side. Each gets its own process, model, and permission settings.
- **Streaming.** Responses render token by token. You see what the agent is writing as it writes it.
- **Tool call visibility.** Every Bash command, file read, edit, grep, visible in collapsible blocks with syntax highlighting.
- **Subagent nesting.** When an agent spawns sub-agents, their work renders hierarchically so you can follow the full chain.
- **Permission control.** Four modes, from auto-approve everything down to manual approval for each tool call.
- **Session persistence.** Sessions save to disk and auto-recover with `--resume` after server restarts or CLI crashes.
- **Environment profiles.** Store API keys and config per-project in `~/.companion/envs/` without touching your shell.

## How it works

The Claude Code CLI has a hidden `--sdk-url` flag. When set, it connects to a WebSocket server instead of running in a terminal. The protocol is NDJSON (newline-delimited JSON).

```
┌──────────────┐    WebSocket (NDJSON)    ┌─────────────────┐    WebSocket (JSON)    ┌─────────────┐
│  Claude Code │ ◄───────────────────────► │   Bun + Hono    │ ◄───────────────────► │   Browser   │
│     CLI      │  /ws/cli/:session        │     Server      │  /ws/browser/:session │   (React)   │
└──────────────┘                          └─────────────────┘                       └─────────────┘
```

1. You type a prompt in the browser
2. Server spawns `claude --sdk-url ws://localhost:3456/ws/cli/SESSION_ID`
3. CLI connects back over WebSocket
4. Messages flow both ways: your prompts to the CLI, streaming responses back
5. Tool calls show up as approval prompts in the browser

We documented the full protocol (13 control subtypes, permission flow, reconnection logic, session lifecycle) in [`WEBSOCKET_PROTOCOL_REVERSED.md`](WEBSOCKET_PROTOCOL_REVERSED.md).

## Development

```bash
git clone https://github.com/The-Vibe-Company/companion.git
cd companion/web
bun install
bun run dev       # backend + Vite HMR on :5174
```

Production: `bun run build && bun run start` serves everything on `:3456`.

## Run as a background service (macOS)

Install as a launchd service that starts on login and restarts on crash:

```bash
bun install -g the-companion
the-companion install
```

Other commands:

```bash
the-companion start       # start the installed background service
the-companion status      # check if the service is running
the-companion stop        # stop the service (keeps it installed)
the-companion restart     # restart the service
the-companion logs        # tail stdout/stderr logs
the-companion uninstall   # remove the service
```

Use `--port <n>` with `install` to override the default port (3456).

Dev uses port 3457 for the backend and 5174 for Vite HMR, so both dev and prod can run simultaneously.

## Tech stack

Bun runtime, Hono server, React 19, Zustand, Tailwind v4, Vite.

## Telemetry

The Companion can send product analytics and frontend crash reports to PostHog so we can improve reliability and UX.

- Telemetry is configured via `VITE_POSTHOG_KEY` (and optional `VITE_POSTHOG_HOST`).
- In this open-source repo, telemetry is optional: if no key is configured, nothing is sent.
- Users can disable telemetry anytime in `Settings -> Telemetry`.
- Browser Do Not Track is respected (`respect_dnt` is enabled).

## Cloud

See [`cloud.md`](cloud.md) for the cloud environment roadmap and core image strategy.

## Contributing

Check [open issues](https://github.com/The-Vibe-Company/companion/issues), fork, branch, PR. For protocol-level work, read the [WebSocket spec](WEBSOCKET_PROTOCOL_REVERSED.md) first.

## License

MIT
