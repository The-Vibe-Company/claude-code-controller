import type {
  PermissionAutomationDecision,
  PluginDefinition,
  PluginEvent,
  PluginEventResult,
  PluginRuntimeInfo,
} from "./types.js";
import { PluginStateStore } from "./state-store.js";
import { getBuiltinPlugins } from "./builtins.js";

export interface EmitResult {
  insights: NonNullable<PluginEventResult["insights"]>;
  permissionDecision?: PermissionAutomationDecision;
  userMessageMutation?: NonNullable<PluginEventResult["userMessageMutation"]>;
  aborted: boolean;
}

interface EmitOptions {
  onInsight?: (insight: EmitResult["insights"][number]) => void;
}

const DEFAULT_TIMEOUT_MS = 3000;

export class PluginConfigValidationError extends Error {
  pluginId: string;

  constructor(pluginId: string, message: string) {
    super(message);
    this.name = "PluginConfigValidationError";
    this.pluginId = pluginId;
  }
}

function toPluginErrorInsight(pluginId: string, event: PluginEvent, err: unknown) {
  return {
    id: `${pluginId}-${Date.now()}-error`,
    plugin_id: pluginId,
    title: "Plugin error",
    message: err instanceof Error ? err.message : String(err),
    level: "error" as const,
    timestamp: Date.now(),
    event_name: event.name,
    session_id: event.meta.sessionId,
  };
}

function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Plugin timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export class PluginManager {
  private definitions = new Map<string, PluginDefinition<any>>();
  private stateStore: PluginStateStore;
  private warnedInvalidConfig = new Set<string>();

  constructor(stateStore?: PluginStateStore) {
    this.stateStore = stateStore || new PluginStateStore();
    for (const plugin of getBuiltinPlugins()) {
      this.register(plugin);
    }
  }

  register(plugin: PluginDefinition<any>): void {
    this.definitions.set(plugin.id, plugin);
  }

  private resolveConfig(
    plugin: PluginDefinition<any>,
    stateConfig: unknown,
    options: { persistDefaultOnInvalid?: boolean } = {},
  ): unknown {
    const rawConfig = stateConfig ?? plugin.defaultConfig;
    if (!plugin.validateConfig) return rawConfig;
    try {
      return plugin.validateConfig(rawConfig);
    } catch (err) {
      if (!this.warnedInvalidConfig.has(plugin.id)) {
        console.warn(`[plugins] Invalid config for plugin ${plugin.id}, falling back to defaults:`, err);
        this.warnedInvalidConfig.add(plugin.id);
      }
      if (options.persistDefaultOnInvalid && stateConfig !== undefined) {
        this.stateStore.update((draft) => {
          draft.config[plugin.id] = plugin.defaultConfig;
        });
      }
      return plugin.defaultConfig;
    }
  }

  list(): PluginRuntimeInfo[] {
    const state = this.stateStore.getState();
    return Array.from(this.definitions.values()).map((plugin) => {
      const savedEnabled = state.enabled[plugin.id];
      const enabled = typeof savedEnabled === "boolean" ? savedEnabled : plugin.defaultEnabled;
      const config = this.resolveConfig(plugin, state.config[plugin.id], { persistDefaultOnInvalid: true });

      return {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        events: plugin.events,
        priority: plugin.priority,
        blocking: plugin.blocking,
        timeoutMs: plugin.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        failPolicy: plugin.failPolicy ?? "continue",
        enabled,
        config,
      };
    });
  }

  setEnabled(id: string, enabled: boolean): PluginRuntimeInfo | null {
    const plugin = this.definitions.get(id);
    if (!plugin) return null;

    this.stateStore.update((draft) => {
      draft.enabled[id] = enabled;
    });

    return this.list().find((row) => row.id === id) || null;
  }

  updateConfig(id: string, rawConfig: unknown): PluginRuntimeInfo | null {
    const plugin = this.definitions.get(id);
    if (!plugin) return null;

    let config: unknown;
    try {
      config = plugin.validateConfig ? plugin.validateConfig(rawConfig) : rawConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new PluginConfigValidationError(id, `Invalid config for plugin ${id}: ${message}`);
    }

    this.stateStore.update((draft) => {
      draft.config[id] = config;
    });
    this.warnedInvalidConfig.delete(id);

    return this.list().find((row) => row.id === id) || null;
  }

  async emit(event: PluginEvent, options: EmitOptions = {}): Promise<EmitResult> {
    const state = this.stateStore.getState();
    const insights: EmitResult["insights"] = [];
    let permissionDecision: PermissionAutomationDecision | undefined;
    let userMessageMutation: EmitResult["userMessageMutation"];
    let aborted = false;
    let mutableEvent: PluginEvent = event;

    const candidates = Array.from(this.definitions.values())
      .filter((plugin) => plugin.events.includes("*") || plugin.events.includes(event.name))
      .sort((a, b) => b.priority - a.priority);

    for (const plugin of candidates) {
      const savedEnabled = state.enabled[plugin.id];
      const enabled = typeof savedEnabled === "boolean" ? savedEnabled : plugin.defaultEnabled;
      if (!enabled) continue;

      const config = this.resolveConfig(plugin, state.config[plugin.id], { persistDefaultOnInvalid: true });
      const timeoutMs = plugin.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const failPolicy = plugin.failPolicy ?? "continue";
      const run = () => runWithTimeout(Promise.resolve(plugin.onEvent(mutableEvent, config)), timeoutMs);

      if (!plugin.blocking) {
        run()
          .then((result) => {
            if (!result?.insights?.length) return;
            for (const insight of result.insights) {
              options.onInsight?.(insight);
            }
          })
          .catch((err) => {
            options.onInsight?.(toPluginErrorInsight(plugin.id, event, err));
          });
        continue;
      }

      let result: PluginEventResult | void;
      try {
        result = await run();
      } catch (err) {
        insights.push(toPluginErrorInsight(plugin.id, event, err));
        if (failPolicy === "abort_current_action") {
          aborted = true;
          break;
        }
        continue;
      }

      if (!result) continue;
      if (result.eventDataPatch && mutableEvent.data && typeof mutableEvent.data === "object") {
        mutableEvent = {
          ...mutableEvent,
          data: {
            ...(mutableEvent.data as Record<string, unknown>),
            ...result.eventDataPatch,
          },
        } as PluginEvent;
      }
      if (result.insights?.length) insights.push(...result.insights);
      if (!permissionDecision && result.permissionDecision) {
        permissionDecision = result.permissionDecision;
      }
      if (result.userMessageMutation) {
        userMessageMutation = {
          ...userMessageMutation,
          ...result.userMessageMutation,
        };
        if (
          mutableEvent.name === "user.message.before_send"
          && mutableEvent.data
          && typeof mutableEvent.data === "object"
        ) {
          const nextData = { ...(mutableEvent.data as Record<string, unknown>) };
          if (typeof result.userMessageMutation.content === "string") {
            nextData.content = result.userMessageMutation.content;
          }
          if (Array.isArray(result.userMessageMutation.images)) {
            nextData.images = result.userMessageMutation.images;
          }
          mutableEvent = { ...mutableEvent, data: nextData } as PluginEvent;
        }
      }
    }

    return { insights, permissionDecision, userMessageMutation, aborted };
  }
}
