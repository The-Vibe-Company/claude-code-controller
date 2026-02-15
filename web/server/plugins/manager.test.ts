import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PluginConfigValidationError, PluginManager } from "./manager.js";
import { PluginStateStore } from "./state-store.js";
import type { PluginDefinition } from "./types.js";

let dir: string;
let manager: PluginManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plugins-test-"));
  const store = new PluginStateStore(join(dir, "plugins.json"));
  manager = new PluginManager(store);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PluginManager", () => {
  it("lists built-in plugins with default states", () => {
    const plugins = manager.list();
    expect(plugins.find((p) => p.id === "notifications")?.enabled).toBe(true);
    expect(plugins.find((p) => p.id === "permission-automation")?.enabled).toBe(false);
  });

  it("enables and disables plugins", () => {
    const enabled = manager.setEnabled("permission-automation", true);
    expect(enabled?.enabled).toBe(true);

    const disabled = manager.setEnabled("permission-automation", false);
    expect(disabled?.enabled).toBe(false);
  });

  it("applies notification plugin on result events", async () => {
    manager.updateConfig("notifications", {
      onSessionCreated: false,
      onSessionEnded: false,
      onResultSuccess: true,
      onResultError: true,
      onPermissionRequest: false,
    });

    const res = await manager.emit({
      name: "result.received",
      meta: {
        eventId: "e1",
        eventVersion: 2,
        timestamp: Date.now(),
        source: "ws-bridge",
        sessionId: "s1",
        backendType: "claude",
      },
      data: {
        sessionId: "s1",
        backendType: "claude",
        result: {
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          uuid: "u1",
          session_id: "s1",
        },
        success: true,
        durationMs: 1,
        costUsd: 0,
        numTurns: 1,
      },
    });

    expect(res.insights.length).toBeGreaterThan(0);
    expect(res.insights[0].plugin_id).toBe("notifications");
  });

  it("returns permission decisions when automation rule matches", async () => {
    manager.setEnabled("permission-automation", true);
    manager.updateConfig("permission-automation", {
      rules: [
        {
          id: "allow-read",
          enabled: true,
          backendType: "any",
          toolName: "Read",
          action: "allow",
          message: "Auto-approved read",
        },
      ],
    });

    const res = await manager.emit({
      name: "permission.requested",
      meta: {
        eventId: "e2",
        eventVersion: 2,
        timestamp: Date.now(),
        source: "ws-bridge",
        sessionId: "s1",
        backendType: "claude",
      },
      data: {
        sessionId: "s1",
        backendType: "claude",
        state: {
          session_id: "s1",
          backend_type: "claude",
          model: "",
          cwd: "/tmp",
          tools: [],
          permissionMode: "default",
          claude_code_version: "",
          mcp_servers: [],
          agents: [],
          slash_commands: [],
          skills: [],
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
          git_branch: "",
          is_worktree: false,
          repo_root: "",
          git_ahead: 0,
          git_behind: 0,
          total_lines_added: 0,
          total_lines_removed: 0,
        },
        permission: {
          request_id: "r1",
          tool_name: "Read",
          input: { file_path: "README.md" },
          tool_use_id: "t1",
          timestamp: Date.now(),
        },
        permissionMode: "default",
        requestHash: "hash-1",
        toolInputNormalized: { filePath: "README.md" },
      },
    });

    expect(res.permissionDecision?.behavior).toBe("allow");
    expect(res.insights.some((i) => i.plugin_id === "permission-automation")).toBe(true);
  });

  it("respects priority order for blocking plugins", async () => {
    const calls: string[] = [];
    const high: PluginDefinition = {
      id: "test-high",
      name: "High",
      version: "1.0.0",
      description: "High",
      events: ["session.created"],
      priority: 100,
      blocking: true,
      defaultEnabled: true,
      defaultConfig: {},
      onEvent: async () => {
        calls.push("high");
      },
    };
    const low: PluginDefinition = {
      id: "test-low",
      name: "Low",
      version: "1.0.0",
      description: "Low",
      events: ["session.created"],
      priority: 10,
      blocking: true,
      defaultEnabled: true,
      defaultConfig: {},
      onEvent: async () => {
        calls.push("low");
      },
    };
    manager.register(low);
    manager.register(high);

    await manager.emit({
      name: "session.created",
      meta: { eventId: "e3", eventVersion: 2, timestamp: Date.now(), source: "routes", sessionId: "s1", backendType: "claude" },
      data: {
        session: {
          session_id: "s1",
          backend_type: "claude",
          model: "",
          cwd: "/tmp",
          tools: [],
          permissionMode: "default",
          claude_code_version: "",
          mcp_servers: [],
          agents: [],
          slash_commands: [],
          skills: [],
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
          git_branch: "",
          is_worktree: false,
          repo_root: "",
          git_ahead: 0,
          git_behind: 0,
          total_lines_added: 0,
          total_lines_removed: 0,
        },
      },
    });

    expect(calls.indexOf("high")).toBeLessThan(calls.indexOf("low"));
  });

  it("runs non-blocking plugins asynchronously while returning immediately", async () => {
    let resolved = false;
    const asyncPlugin: PluginDefinition = {
      id: "test-async",
      name: "Async",
      version: "1.0.0",
      description: "Async",
      events: ["session.killed"],
      priority: 1,
      blocking: false,
      defaultEnabled: true,
      defaultConfig: {},
      onEvent: async () => {
        await new Promise((r) => setTimeout(r, 20));
        resolved = true;
      },
    };
    manager.register(asyncPlugin);

    const res = await manager.emit({
      name: "session.killed",
      meta: { eventId: "e4", eventVersion: 2, timestamp: Date.now(), source: "routes", sessionId: "s1" },
      data: { sessionId: "s1" },
    });
    expect(res.aborted).toBe(false);
    expect(resolved).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(true);
  });

  it("falls back to default config when persisted config is invalid", async () => {
    const brokenPlugin: PluginDefinition<{ enabled: boolean }> = {
      id: "broken-config-plugin",
      name: "Broken Config Plugin",
      version: "1.0.0",
      description: "Tests invalid persisted config handling",
      events: ["session.created"],
      priority: 20,
      blocking: true,
      defaultEnabled: true,
      defaultConfig: { enabled: true },
      validateConfig: (input: unknown) => {
        if (!input || typeof input !== "object") throw new Error("invalid config");
        const row = input as Record<string, unknown>;
        if (typeof row.enabled !== "boolean") throw new Error("invalid enabled");
        return { enabled: row.enabled };
      },
      onEvent: async (_event, config) => ({
        insights: [{
          id: "ok",
          plugin_id: "broken-config-plugin",
          title: "OK",
          message: config.enabled ? "Default config applied" : "Unexpected config",
          level: config.enabled ? "success" : "error",
          timestamp: Date.now(),
        }],
      }),
    };

    manager.register(brokenPlugin);
    writeFileSync(join(dir, "plugins.json"), JSON.stringify({
      updatedAt: Date.now(),
      enabled: {},
      config: {
        "broken-config-plugin": "not-an-object",
      },
    }), "utf-8");

    const freshManager = new PluginManager(new PluginStateStore(join(dir, "plugins.json")));
    freshManager.register(brokenPlugin);

    const listed = freshManager.list().find((p) => p.id === "broken-config-plugin");
    expect(listed?.config).toEqual({ enabled: true });
    const healedState = JSON.parse(readFileSync(join(dir, "plugins.json"), "utf-8")) as {
      config: Record<string, unknown>;
    };
    expect(healedState.config["broken-config-plugin"]).toEqual({ enabled: true });

    const emitted = await freshManager.emit({
      name: "session.created",
      meta: {
        eventId: "e5",
        eventVersion: 2,
        timestamp: Date.now(),
        source: "routes",
        sessionId: "s1",
        backendType: "claude",
      },
      data: {
        session: {
          session_id: "s1",
          backend_type: "claude",
          model: "",
          cwd: "/tmp",
          tools: [],
          permissionMode: "default",
          claude_code_version: "",
          mcp_servers: [],
          agents: [],
          slash_commands: [],
          skills: [],
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
          git_branch: "",
          is_worktree: false,
          repo_root: "",
          git_ahead: 0,
          git_behind: 0,
          total_lines_added: 0,
          total_lines_removed: 0,
        },
      },
    });

    expect(emitted.insights.some((i) => i.plugin_id === "broken-config-plugin" && i.level === "success")).toBe(true);
  });

  it("throws PluginConfigValidationError when updateConfig receives invalid input", () => {
    const strictPlugin: PluginDefinition<{ required: string }> = {
      id: "strict-plugin",
      name: "Strict",
      version: "1.0.0",
      description: "Strict plugin validation",
      events: ["session.created"],
      priority: 1,
      blocking: true,
      defaultEnabled: true,
      defaultConfig: { required: "ok" },
      validateConfig: (input: unknown) => {
        if (!input || typeof input !== "object") throw new Error("config must be object");
        const row = input as Record<string, unknown>;
        if (typeof row.required !== "string") throw new Error("required must be string");
        return { required: row.required };
      },
      onEvent: () => undefined,
    };
    manager.register(strictPlugin);

    expect(() => manager.updateConfig("strict-plugin", { required: 123 })).toThrow(PluginConfigValidationError);
  });

  it("supports wildcard subscriptions and middleware-style user message mutations", async () => {
    const globalPlugin: PluginDefinition = {
      id: "global-plugin",
      name: "Global",
      version: "1.0.0",
      description: "Runs on all events",
      events: ["*"],
      priority: 100,
      blocking: true,
      defaultEnabled: true,
      defaultConfig: {},
      onEvent: (event) => {
        if (event.name === "user.message.before_send") {
          return {
            userMessageMutation: {
              content: `[global] ${event.data.content}`,
              pluginId: "global-plugin",
            },
          };
        }
        return;
      },
    };

    const projectPlugin: PluginDefinition = {
      id: "project-plugin",
      name: "Project",
      version: "1.0.0",
      description: "Project-specific message middleware",
      events: ["user.message.before_send"],
      priority: 50,
      blocking: true,
      defaultEnabled: true,
      defaultConfig: {},
      onEvent: (event) => {
        if (event.name !== "user.message.before_send") return;
        return {
          userMessageMutation: {
            content: `${event.data.content} [project]`,
            pluginId: "project-plugin",
          },
        };
      },
    };

    manager.register(projectPlugin);
    manager.register(globalPlugin);

    const res = await manager.emit({
      name: "user.message.before_send",
      meta: {
        eventId: "e6",
        eventVersion: 2,
        timestamp: Date.now(),
        source: "ws-bridge",
        sessionId: "s1",
        backendType: "claude",
      },
      data: {
        sessionId: "s1",
        backendType: "claude",
        state: {
          session_id: "s1",
          backend_type: "claude",
          model: "",
          cwd: "/repo/project-x",
          tools: [],
          permissionMode: "default",
          claude_code_version: "",
          mcp_servers: [],
          agents: [],
          slash_commands: [],
          skills: [],
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
          git_branch: "",
          is_worktree: false,
          repo_root: "",
          git_ahead: 0,
          git_behind: 0,
          total_lines_added: 0,
          total_lines_removed: 0,
        },
        content: "hello",
      },
    });

    expect(res.userMessageMutation?.content).toBe("[global] hello [project]");
  });
});
