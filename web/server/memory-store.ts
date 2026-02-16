/**
 * Memory Store - manages the ~/.companion/memory directory structure
 *
 * Directory layout:
 * ~/.companion/memory/
 *   MEMORY.md                  - Global long-term memory
 *   config.json                - Memory configuration
 *   sessions/YYYY-MM-DD.md     - Daily session logs
 *   projects/<slug>/           - Per-project memories
 *   skills/<slug>.md           - Skill-specific learnings
 *   .memorydb                  - SQLite database (chunks, embeddings, FTS5)
 */

import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MemoryConfig, MemorySource } from "./memory-types.js";
import { DEFAULT_MEMORY_CONFIG } from "./memory-types.js";

// ─── Paths ──────────────────────────────────────────────────────────────────

const COMPANION_DIR = join(homedir(), ".companion");
const MEMORY_DIR = join(COMPANION_DIR, "memory");
const CONFIG_FILE = join(MEMORY_DIR, "config.json");
const DB_FILE = join(MEMORY_DIR, ".memorydb");
const GLOBAL_MEMORY_FILE = join(MEMORY_DIR, "MEMORY.md");

export class MemoryStore {
  readonly memoryDir: string;
  readonly configFile: string;
  readonly dbFile: string;
  readonly globalMemoryFile: string;

  constructor(memoryDir?: string) {
    this.memoryDir = memoryDir || MEMORY_DIR;
    this.configFile = join(this.memoryDir, "config.json");
    this.dbFile = join(this.memoryDir, ".memorydb");
    this.globalMemoryFile = join(this.memoryDir, "MEMORY.md");
  }

  // ─── Initialization ───────────────────────────────────────────────────────

  /**
   * Initialize the memory directory structure if it doesn't exist.
   * Creates all necessary subdirectories and files.
   */
  initialize(): void {
    // Create main memory directory
    mkdirSync(this.memoryDir, { recursive: true });

    // Create subdirectories
    const subdirs = ["sessions", "projects", "skills"];
    for (const subdir of subdirs) {
      mkdirSync(join(this.memoryDir, subdir), { recursive: true });
    }

    // Initialize global MEMORY.md if it doesn't exist
    if (!existsSync(this.globalMemoryFile)) {
      const template = `# Companion Memory

This is your long-term memory across all Companion sessions.

## Key Learnings

- [Add important learnings here that should persist across sessions]

## Important Context

- [Project-specific context that applies broadly]

## Common Patterns

- [Workflow patterns, coding conventions, etc.]

## Known Issues

- [Bugs, gotchas, workarounds]

---

*This file is automatically loaded into session context. Keep it concise.*
`;
      writeFileSync(this.globalMemoryFile, template, "utf-8");
    }

    // Initialize config if it doesn't exist
    if (!existsSync(this.configFile)) {
      const config: MemoryConfig = {
        ...DEFAULT_MEMORY_CONFIG,
        storePath: this.memoryDir,
      };
      this.saveConfig(config);
    }
  }

  // ─── Configuration ────────────────────────────────────────────────────────

  /**
   * Load memory configuration from disk.
   * Returns default config if file doesn't exist or is corrupt.
   */
  loadConfig(): MemoryConfig {
    try {
      const raw = readFileSync(this.configFile, "utf-8");
      const loaded = JSON.parse(raw) as Partial<MemoryConfig>;
      // Merge with defaults to ensure all fields exist
      return {
        ...DEFAULT_MEMORY_CONFIG,
        ...loaded,
        storePath: this.memoryDir,
        search: { ...DEFAULT_MEMORY_CONFIG.search, ...loaded.search },
        chunking: { ...DEFAULT_MEMORY_CONFIG.chunking, ...loaded.chunking },
        autoFlush: { ...DEFAULT_MEMORY_CONFIG.autoFlush, ...loaded.autoFlush },
        sessionInjection: {
          ...DEFAULT_MEMORY_CONFIG.sessionInjection,
          ...loaded.sessionInjection,
        },
      };
    } catch {
      return { ...DEFAULT_MEMORY_CONFIG, storePath: this.memoryDir };
    }
  }

  /**
   * Save memory configuration to disk.
   */
  saveConfig(config: MemoryConfig): void {
    writeFileSync(this.configFile, JSON.stringify(config, null, 2), "utf-8");
  }

  /**
   * Update specific config fields.
   */
  updateConfig(updates: Partial<MemoryConfig>): MemoryConfig {
    const config = this.loadConfig();
    const updated = { ...config, ...updates };
    this.saveConfig(updated);
    return updated;
  }

  // ─── File Helpers ─────────────────────────────────────────────────────────

  /**
   * Get the absolute path for a memory source file.
   */
  getSourcePath(source: MemorySource, identifier?: string): string {
    switch (source) {
      case "global":
        return this.globalMemoryFile;
      case "session":
        return join(this.memoryDir, "sessions", identifier || "");
      case "project":
        return join(this.memoryDir, "projects", identifier || "");
      case "skill":
        return join(this.memoryDir, "skills", identifier ? `${identifier}.md` : "");
    }
  }

  /**
   * Get daily session log file path for a given date.
   * Format: sessions/YYYY-MM-DD.md
   */
  getSessionLogPath(date?: Date): string {
    const d = date || new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return join(this.memoryDir, "sessions", `${yyyy}-${mm}-${dd}.md`);
  }

  /**
   * Ensure a session log file exists for the given date.
   */
  ensureSessionLog(date?: Date): string {
    const path = this.getSessionLogPath(date);
    if (!existsSync(path)) {
      const d = date || new Date();
      const dateStr = d.toISOString().split("T")[0];
      const template = `# Session Log - ${dateStr}

## Sessions

<!-- Add session notes here -->

---
`;
      writeFileSync(path, template, "utf-8");
    }
    return path;
  }

  /**
   * Get project memory directory path.
   */
  getProjectPath(projectSlug: string): string {
    const dir = join(this.memoryDir, "projects", projectSlug);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Get skill memory file path.
   */
  getSkillPath(skillSlug: string): string {
    return join(this.memoryDir, "skills", `${skillSlug}.md`);
  }

  // ─── File Discovery ───────────────────────────────────────────────────────

  /**
   * List all memory markdown files matching the source patterns.
   */
  listMemoryFiles(): Array<{ path: string; source: MemorySource; absolutePath: string }> {
    const files: Array<{ path: string; source: MemorySource; absolutePath: string }> = [];

    // Global memory
    if (existsSync(this.globalMemoryFile)) {
      files.push({
        path: "MEMORY.md",
        source: "global",
        absolutePath: this.globalMemoryFile,
      });
    }

    // Session logs
    const sessionsDir = join(this.memoryDir, "sessions");
    if (existsSync(sessionsDir)) {
      const sessionFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".md"));
      for (const file of sessionFiles) {
        files.push({
          path: `sessions/${file}`,
          source: "session",
          absolutePath: join(sessionsDir, file),
        });
      }
    }

    // Project memories
    const projectsDir = join(this.memoryDir, "projects");
    if (existsSync(projectsDir)) {
      const projectSlugs = readdirSync(projectsDir).filter((f) => {
        const stat = statSync(join(projectsDir, f));
        return stat.isDirectory();
      });
      for (const slug of projectSlugs) {
        const projectDir = join(projectsDir, slug);
        const projectFiles = readdirSync(projectDir).filter((f) => f.endsWith(".md"));
        for (const file of projectFiles) {
          files.push({
            path: `projects/${slug}/${file}`,
            source: "project",
            absolutePath: join(projectDir, file),
          });
        }
      }
    }

    // Skill memories
    const skillsDir = join(this.memoryDir, "skills");
    if (existsSync(skillsDir)) {
      const skillFiles = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
      for (const file of skillFiles) {
        files.push({
          path: `skills/${file}`,
          source: "skill",
          absolutePath: join(skillsDir, file),
        });
      }
    }

    return files;
  }

  /**
   * Get storage size in bytes.
   */
  getStorageSize(): number {
    let total = 0;

    const countDir = (dir: string) => {
      if (!existsSync(dir)) return;
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const path = join(dir, entry);
          const stat = statSync(path);
          if (stat.isDirectory()) {
            countDir(path);
          } else {
            total += stat.size;
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    };

    countDir(this.memoryDir);
    return total;
  }

  // ─── Database ─────────────────────────────────────────────────────────────

  /**
   * Get the SQLite database file path.
   */
  getDatabasePath(): string {
    return this.dbFile;
  }

  /**
   * Check if the database exists.
   */
  hasDatabaseFile(): boolean {
    return existsSync(this.dbFile);
  }
}

// ─── Singleton Instance ─────────────────────────────────────────────────────

let instance: MemoryStore | null = null;

/**
 * Get the singleton memory store instance.
 */
export function getMemoryStore(memoryDir?: string): MemoryStore {
  if (!instance) {
    instance = new MemoryStore(memoryDir);
  }
  return instance;
}
