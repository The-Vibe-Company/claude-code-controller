/**
 * Memory Manager - high-level API for memory operations
 *
 * This is the main entry point for interacting with the memory system.
 * It coordinates between the store, database, search engine, and embeddings.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type {
  MemoryConfig,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryStats,
  MemorySource,
} from "./memory-types.js";
import { DEFAULT_MEMORY_CONFIG } from "./memory-types.js";
import { getMemoryStore, MemoryStore } from "./memory-store.js";
import { MemoryDatabase } from "./memory-db.js";
import { MemorySearchEngine, reindexAllMemory, getMemoryStats } from "./memory-search.js";
import { chunkMarkdownFile } from "./memory-chunker.js";
import { EmbeddingService } from "./memory-embeddings.js";

// ─── Memory Manager ─────────────────────────────────────────────────────────

export class MemoryManager {
  private store: MemoryStore;
  private config: MemoryConfig;

  constructor(config?: Partial<MemoryConfig>) {
    // Merge with defaults
    this.config = {
      ...DEFAULT_MEMORY_CONFIG,
      ...config,
      storePath: config?.storePath || DEFAULT_MEMORY_CONFIG.storePath,
    };

    // Initialize store
    this.store = getMemoryStore(this.config.storePath);
    this.store.initialize();

    // Load config from disk if it exists, merge with provided config
    const diskConfig = this.store.loadConfig();
    this.config = { ...diskConfig, ...config };
  }

  // ─── Configuration ────────────────────────────────────────────────────────

  /**
   * Get current memory configuration.
   */
  getConfig(): MemoryConfig {
    return { ...this.config };
  }

  /**
   * Update memory configuration.
   */
  updateConfig(updates: Partial<MemoryConfig>): MemoryConfig {
    this.config = this.store.updateConfig({ ...this.config, ...updates });
    return this.config;
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  /**
   * Search memory with hybrid BM25 + vector search.
   */
  async search(options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    if (!this.config.enabled) {
      throw new Error("Memory system is disabled in configuration");
    }

    const engine = new MemorySearchEngine(this.config);
    try {
      return await engine.search(options);
    } finally {
      engine.close();
    }
  }

  // ─── Indexing ─────────────────────────────────────────────────────────────

  /**
   * Re-index all memory files.
   */
  async reindex(
    onProgress?: (current: number, total: number, file: string) => void,
  ): Promise<void> {
    if (!this.config.enabled) {
      throw new Error("Memory system is disabled in configuration");
    }

    await reindexAllMemory(this.config, onProgress);
  }

  /**
   * Index a single file (add or update).
   */
  async indexFile(
    source: MemorySource,
    path: string,
    content: string,
  ): Promise<number> {
    if (!this.config.enabled) {
      throw new Error("Memory system is disabled in configuration");
    }

    const db = new MemoryDatabase(this.store.getDatabasePath());
    const embeddings = new EmbeddingService({
      provider: this.config.search.provider,
      model: this.config.search.model,
      apiKey: this.config.search.apiKey,
    });

    try {
      // Chunk the content
      const chunks = chunkMarkdownFile(path, source, content, {
        maxTokens: this.config.chunking.maxTokens,
        overlapTokens: this.config.chunking.overlapTokens,
      });

      // Index chunks
      const { indexMemoryFile } = await import("./memory-search.js");
      await indexMemoryFile(
        db,
        embeddings,
        this.config,
        { path, source, absolutePath: "", content },
        chunks,
      );

      return chunks.length;
    } finally {
      db.close();
    }
  }

  /**
   * Remove a file from the index.
   */
  removeFile(path: string): number {
    const db = new MemoryDatabase(this.store.getDatabasePath());
    try {
      return db.deleteChunksByPath(path);
    } finally {
      db.close();
    }
  }

  // ─── Memory Writing ───────────────────────────────────────────────────────

  /**
   * Append content to today's session log.
   */
  appendToSessionLog(content: string): string {
    const logPath = this.store.ensureSessionLog();
    const existing = readFileSync(logPath, "utf-8");

    // Append with timestamp
    const timestamp = new Date().toISOString();
    const entry = `\n## ${timestamp}\n\n${content}\n`;

    writeFileSync(logPath, existing + entry, "utf-8");

    // Re-index the file
    this.indexFile("session", logPath.replace(this.config.storePath + "/", ""), existing + entry)
      .catch((err) => console.error("[memory] Failed to re-index session log:", err));

    return logPath;
  }

  /**
   * Write to global MEMORY.md file.
   */
  writeGlobalMemory(content: string): void {
    writeFileSync(this.store.globalMemoryFile, content, "utf-8");

    // Re-index
    this.indexFile("global", "MEMORY.md", content)
      .catch((err) => console.error("[memory] Failed to re-index global memory:", err));
  }

  /**
   * Append to global MEMORY.md file.
   */
  appendToGlobalMemory(content: string): void {
    const existing = readFileSync(this.store.globalMemoryFile, "utf-8");
    const updated = existing + "\n\n" + content;
    this.writeGlobalMemory(updated);
  }

  /**
   * Write to a skill memory file.
   */
  writeSkillMemory(skillSlug: string, content: string): void {
    const skillPath = this.store.getSkillPath(skillSlug);
    writeFileSync(skillPath, content, "utf-8");

    // Re-index
    this.indexFile("skill", `skills/${skillSlug}.md`, content)
      .catch((err) => console.error("[memory] Failed to re-index skill memory:", err));
  }

  /**
   * Write to a project memory file.
   */
  writeProjectMemory(projectSlug: string, fileName: string, content: string): void {
    const projectDir = this.store.getProjectPath(projectSlug);
    const filePath = `${projectDir}/${fileName}`;
    writeFileSync(filePath, content, "utf-8");

    // Re-index
    this.indexFile("project", `projects/${projectSlug}/${fileName}`, content)
      .catch((err) => console.error("[memory] Failed to re-index project memory:", err));
  }

  // ─── Statistics ───────────────────────────────────────────────────────────

  /**
   * Get memory statistics.
   */
  getStats(): MemoryStats {
    return getMemoryStats(this.config);
  }

  /**
   * Get list of all indexed files.
   */
  listFiles(): Array<{ path: string; source: MemorySource; absolutePath: string }> {
    return this.store.listMemoryFiles();
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  /**
   * Check if memory system is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Check if embeddings are enabled.
   */
  hasEmbeddings(): boolean {
    return this.config.search.provider !== "disabled";
  }

  /**
   * Get the memory directory path.
   */
  getMemoryDir(): string {
    return this.config.storePath;
  }
}

// ─── Singleton Instance ─────────────────────────────────────────────────────

let instance: MemoryManager | null = null;

/**
 * Get or create the singleton memory manager instance.
 */
export function getMemoryManager(config?: Partial<MemoryConfig>): MemoryManager {
  if (!instance) {
    instance = new MemoryManager(config);
  }
  return instance;
}

/**
 * Reset the singleton instance (useful for tests).
 */
export function resetMemoryManager(): void {
  instance = null;
}
