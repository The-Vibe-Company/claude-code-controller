# Companion Plugin Authoring Guide

This directory contains Companion's server-side plugin runtime.

Important: Companion does not load third-party plugins dynamically at runtime.
Plugin contributions are merged through pull requests, then bundled as built-in plugins.

## Quick Start (PR-friendly)

Generate a plugin scaffold:

```bash
cd web
bun run plugin:new my-plugin-id
```

This command creates:

- `server/plugins/my-plugin-id.ts`
- `server/plugins/my-plugin-id.test.ts`
- registration in `server/plugins/builtins.ts`

Then run:

```bash
bun run typecheck
bun run test
```

## Runtime Contract

All plugin events use a versioned envelope:

```ts
{
  name: PluginEventName,
  meta: {
    eventId: string,
    eventVersion: 2,
    timestamp: number,
    source: "routes" | "ws-bridge" | "codex-adapter" | "plugin-manager",
    sessionId?: string,
    backendType?: "claude" | "codex",
    correlationId?: string,
  },
  data: PluginEventMap[name],
}
```

`eventVersion` is required for forward compatibility.

## Execution Policy

Each plugin must define deterministic execution behavior:

- `priority`: higher values run first for the same event.
- `blocking`:
  - `true`: plugin runs in the blocking chain.
  - `false`: plugin runs fire-and-forget.
- `timeoutMs`: max runtime for one event invocation.
- `failPolicy`:
  - `continue`: continue the chain after plugin failure.
  - `abort_current_action`: stop processing the current action.

Use `abort_current_action` only for safety-critical flows.

## Plugin Definition Standard

```ts
const plugin: PluginDefinition<MyConfig> = {
  id: "my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  description: "What this plugin does.",
  events: ["result.received"], // or ["*"] for all events
  priority: 100,
  blocking: true,
  timeoutMs: 1000,
  failPolicy: "continue",
  defaultEnabled: false,
  defaultConfig: { /* ... */ },
  validateConfig: (raw) => normalizedConfig,
  onEvent: async (event, config) => {
    // return insights, permissionDecision, userMessageMutation, and/or eventDataPatch
  },
};
```

## Middleware Pattern

Use `user.message.before_send` for middleware-like transformations:

- `userMessageMutation.content`: rewrite outgoing user text.
- `userMessageMutation.images`: rewrite outgoing images.
- `userMessageMutation.blocked`: block message delivery.
- `userMessageMutation.message`: explain why a message was blocked.

Use this only when behavior is explicit and predictable.

## UI Integration Expectations

Plugin insights are shown in:

- top bar badges and quick actions (if pinned)
- session panel automation section
- chat feed system entries

To keep UI usable, insight messages should be:

- short (1 sentence)
- actionable
- non-spammy
- stable in wording

## Required Test Coverage for Plugin PRs

Each plugin PR should include tests for:

1. config validation (valid + invalid payloads)
2. enabled/disabled behavior
3. primary event path
4. timeout/failure behavior where relevant
5. mutation/decision outputs (if plugin uses middleware or permissions)

## Compatibility Requirements

All plugin behavior must be compatible with both backends:

- Claude Code (`backendType = "claude"`)
- Codex (`backendType = "codex"`)

If behavior is backend-specific, gate it explicitly and document it.

## PR Checklist

- plugin `id` is kebab-case and stable
- `defaultEnabled` is intentional and justified
- `priority`, `blocking`, `timeoutMs`, `failPolicy` are explicitly chosen
- config schema has `validateConfig`
- tests added and passing
- user-facing insight text reviewed for clarity
- no route/session flow is blocked by non-critical plugin failures
