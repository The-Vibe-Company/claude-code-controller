import type { PluginDefinition, PluginEventResult } from "./types.js";

interface MyPluginConfig {
  enabledEvents: string[];
}

function validateConfig(input: unknown): MyPluginConfig {
  const src = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return {
    enabledEvents: Array.isArray(src.enabledEvents)
      ? src.enabledEvents.filter((v): v is string => typeof v === "string")
      : [],
  };
}

export const myPluginTemplate: PluginDefinition<MyPluginConfig> = {
  id: "my-plugin-template",
  name: "My Plugin Template",
  version: "1.0.0",
  description: "Template for building Companion plugins.",
  events: ["*"],
  priority: 100,
  blocking: true,
  timeoutMs: 1000,
  failPolicy: "continue",
  defaultEnabled: false,
  defaultConfig: { enabledEvents: ["result.received", "user.message.before_send"] },
  validateConfig,
  onEvent: async (event, config): Promise<PluginEventResult | void> => {
    if (!config.enabledEvents.includes(event.name)) return;

    if (event.name === "result.received") {
      return {
        insights: [
          {
            id: `my-plugin-template-${Date.now()}`,
            plugin_id: "my-plugin-template",
            title: "Template insight",
            message: `Session ${event.data.sessionId} completed (${event.data.numTurns} turns).`,
            level: event.data.success ? "success" : "error",
            timestamp: Date.now(),
            session_id: event.data.sessionId,
            event_name: event.name,
          },
        ],
      };
    }

    if (event.name === "user.message.before_send") {
      if (event.data.state.cwd.includes("/my-special-project")) {
        return {
          userMessageMutation: {
            content: `[project-x] ${event.data.content}`,
            pluginId: "my-plugin-template",
          },
        };
      }
    }

    return;
  },
};
