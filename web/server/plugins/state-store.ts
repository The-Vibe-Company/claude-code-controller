import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { PluginStateFile } from "./types.js";

const DEFAULT_PATH = join(homedir(), ".companion", "plugins.json");

const EMPTY_STATE: PluginStateFile = {
  updatedAt: 0,
  enabled: {},
  config: {},
};

function freshEmptyState(): PluginStateFile {
  return {
    updatedAt: EMPTY_STATE.updatedAt,
    enabled: {},
    config: {},
  };
}

export class PluginStateStore {
  private filePath: string;
  private loaded = false;
  private state: PluginStateFile = freshEmptyState();

  constructor(filePath?: string) {
    this.filePath = filePath || DEFAULT_PATH;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    if (!existsSync(this.filePath)) {
      this.state = freshEmptyState();
      this.loaded = true;
      return;
    }

    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<PluginStateFile>;
      this.state = {
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
        enabled: raw.enabled && typeof raw.enabled === "object" ? raw.enabled as Record<string, boolean> : {},
        config: raw.config && typeof raw.config === "object" ? raw.config as Record<string, unknown> : {},
      };
    } catch {
      this.state = freshEmptyState();
    }

    this.loaded = true;
  }

  getState(): PluginStateFile {
    this.ensureLoaded();
    return {
      updatedAt: this.state.updatedAt,
      enabled: { ...this.state.enabled },
      config: { ...this.state.config },
    };
  }

  update(mutator: (draft: PluginStateFile) => void): PluginStateFile {
    this.ensureLoaded();
    mutator(this.state);
    this.state.updatedAt = Date.now();
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
    return this.getState();
  }

  _resetForTest(filePath?: string): void {
    this.filePath = filePath || DEFAULT_PATH;
    this.loaded = false;
    this.state = freshEmptyState();
  }
}
