import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function usage(): never {
  console.error("Usage: bun run plugin:new <plugin-id>");
  console.error("Example: bun run plugin:new project-prefixer");
  process.exit(1);
}

function isValidPluginId(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function toPascalCase(value: string): string {
  return value
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("");
}

function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return pascal[0]?.toLowerCase() + pascal.slice(1);
}

function updateBuiltinsFile(filePath: string, pluginId: string, pluginConstName: string): void {
  let content = readFileSync(filePath, "utf-8");

  const importLine = `import { ${pluginConstName} } from "./${pluginId}.js";`;
  if (!content.includes(importLine)) {
    const marker = `} from "./types.js";\n`;
    const markerIndex = content.indexOf(marker);
    if (markerIndex === -1) {
      throw new Error("Could not find plugin type imports in builtins.ts");
    }
    const insertAt = markerIndex + marker.length;
    content = `${content.slice(0, insertAt)}${importLine}\n${content.slice(insertAt)}`;
  }

  const returnMatch = content.match(/return \[([^\]]*)\];/);
  if (!returnMatch) {
    throw new Error("Could not find getBuiltinPlugins() return array in builtins.ts");
  }

  const returnItemsRaw = returnMatch[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!returnItemsRaw.includes(pluginConstName)) {
    returnItemsRaw.push(pluginConstName);
  }

  const formatted = `return [${returnItemsRaw.join(", ")}];`;
  content = content.replace(/return \[([^\]]*)\];/, formatted);
  writeFileSync(filePath, content, "utf-8");
}

function createPluginTemplate(pluginId: string, pluginConstName: string, configTypeName: string): string {
  return `import type { PluginDefinition, PluginEventResult } from "./types.js";

interface ${configTypeName} {
  enabled: boolean;
}

function normalizeConfig(input: unknown): ${configTypeName} {
  const src = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : true,
  };
}

export const ${pluginConstName}: PluginDefinition<${configTypeName}> = {
  id: "${pluginId}",
  name: "${toPascalCase(pluginId)}",
  version: "1.0.0",
  description: "Describe what this plugin does.",
  events: ["session.created"],
  priority: 100,
  blocking: true,
  timeoutMs: 1000,
  failPolicy: "continue",
  defaultEnabled: false,
  defaultConfig: {
    enabled: true,
  },
  validateConfig: normalizeConfig,
  onEvent: (event, config): PluginEventResult | void => {
    if (!config.enabled) return;
    if (event.name !== "session.created") return;

    return {
      insights: [
        {
          id: \`${pluginId}-\${Date.now()}\`,
          plugin_id: "${pluginId}",
          title: "Plugin initialized",
          message: "Replace this insight with your plugin behavior.",
          level: "info",
          timestamp: Date.now(),
          session_id: event.data.session.session_id,
          event_name: event.name,
        },
      ],
    };
  },
};
`;
}

function createPluginTestTemplate(pluginId: string, pluginConstName: string): string {
  return `import { describe, it, expect } from "vitest";
import { PluginManager } from "./manager.js";
import { PluginStateStore } from "./state-store.js";
import { ${pluginConstName} } from "./${pluginId}.js";

describe("${pluginId}", () => {
  it("emits insights on session.created when enabled", async () => {
    const manager = new PluginManager(new PluginStateStore(":memory:"));
    manager.register(${pluginConstName});
    manager.setEnabled("${pluginId}", true);

    // Validate the plugin's primary event path with the minimal session payload.
    const result = await manager.emit({
      name: "session.created",
      meta: {
        eventId: "e-${pluginId}",
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

    expect(result.insights.some((insight) => insight.plugin_id === "${pluginId}")).toBe(true);
  });
});
`;
}

const pluginId = Bun.argv[2];
if (!pluginId) usage();
if (!isValidPluginId(pluginId)) {
  console.error(`Invalid plugin id "${pluginId}". Use kebab-case: letters, numbers, and dashes.`);
  process.exit(1);
}

const pluginConstName = `${toCamelCase(pluginId)}Plugin`;
const configTypeName = `${toPascalCase(pluginId)}Config`;
const dir = import.meta.dir;
const pluginFilePath = join(dir, `${pluginId}.ts`);
const pluginTestPath = join(dir, `${pluginId}.test.ts`);
const builtinsPath = join(dir, "builtins.ts");

if (existsSync(pluginFilePath) || existsSync(pluginTestPath)) {
  console.error(`Plugin files already exist for "${pluginId}".`);
  process.exit(1);
}

writeFileSync(pluginFilePath, createPluginTemplate(pluginId, pluginConstName, configTypeName), "utf-8");
writeFileSync(pluginTestPath, createPluginTestTemplate(pluginId, pluginConstName), "utf-8");
updateBuiltinsFile(builtinsPath, pluginId, pluginConstName);

console.log(`Created: ${pluginFilePath}`);
console.log(`Created: ${pluginTestPath}`);
console.log(`Updated: ${builtinsPath}`);
console.log("");
console.log("Next steps:");
console.log(`1. Implement behavior in server/plugins/${pluginId}.ts`);
console.log(`2. Expand tests in server/plugins/${pluginId}.test.ts`);
console.log("3. Run: bun run typecheck && bun run test");
