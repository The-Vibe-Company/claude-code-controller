/**
 * Memory system types - inspired by OpenClaw's architecture
 *
 * The memory system consists of:
 * - Markdown files as source of truth
 * - SQLite for vector embeddings and FTS5 for full-text search
 * - Hybrid search combining semantic (vector) + keyword (BM25)
 */

// ─── Core Types ─────────────────────────────────────────────────────────────

export type MemorySource = "global" | "session" | "project" | "skill";

export interface MemoryChunk {
  id: string; // hash of path + line range
  path: string; // relative to memory root
  source: MemorySource;
  startLine: number;
  endLine: number;
  hash: string; // content hash for caching
  text: string;
  embedding?: number[]; // vector embedding
  updatedAt: number;
}

export interface MemoryFile {
  path: string; // relative to memory root
  source: MemorySource;
  absolutePath: string;
  hash: string; // file content hash
  chunks: MemoryChunk[];
  updatedAt: number;
}

// ─── Search Types ───────────────────────────────────────────────────────────

export interface MemorySearchOptions {
  query: string;
  limit?: number;
  minScore?: number;
  sources?: MemorySource[];
  hybridWeight?: { vector: number; bm25: number }; // weights must sum to 1.0
}

export interface MemorySearchResult {
  chunk: MemoryChunk;
  score: number;
  vectorScore?: number;
  bm25Score?: number;
  citation: string; // "path:startLine-endLine"
}

// ─── Embedding Provider Types ───────────────────────────────────────────────

export type EmbeddingProvider = "openai" | "local" | "disabled";

export interface EmbeddingProviderConfig {
  provider: EmbeddingProvider;
  model?: string; // e.g. "text-embedding-3-small"
  apiKey?: string;
  dimensions?: number; // embedding dimensions (e.g. 1536)
}

export interface EmbeddingCacheEntry {
  provider: string;
  model: string;
  hash: string; // content hash
  embedding: number[];
  updatedAt: number;
}

// ─── Memory Configuration ───────────────────────────────────────────────────

export interface MemoryConfig {
  enabled: boolean;
  storePath: string; // absolute path to ~/.companion/memory

  search: {
    provider: EmbeddingProvider;
    model: string;
    apiKey?: string;
    hybrid: {
      enabled: boolean;
      vectorWeight: number; // default: 0.7
      bm25Weight: number; // default: 0.3
    };
    cache: {
      enabled: boolean;
      maxEntries: number; // default: 50000
    };
  };

  chunking: {
    maxTokens: number; // default: 400
    overlapTokens: number; // default: 80
  };

  autoFlush: {
    enabled: boolean;
    thresholdTokens: number; // default: 40000
  };

  sessionInjection: {
    enabled: boolean;
    maxSnippets: number; // default: 5
    minScore: number; // default: 0.6
  };

  sources: string[]; // glob patterns for memory files
}

// ─── Memory Statistics ──────────────────────────────────────────────────────

export interface MemoryStats {
  totalFiles: number;
  totalChunks: number;
  totalEmbeddings: number;
  cacheEntries: number;
  cacheHitRate?: number;
  lastSync: number;
  storageSize: number; // bytes
  sources: {
    global: number;
    session: number;
    project: number;
    skill: number;
  };
}

// ─── Default Configuration ──────────────────────────────────────────────────

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  storePath: "", // will be set at runtime to ~/.companion/memory

  search: {
    provider: "openai",
    model: "text-embedding-3-small",
    hybrid: {
      enabled: true,
      vectorWeight: 0.7,
      bm25Weight: 0.3,
    },
    cache: {
      enabled: true,
      maxEntries: 50000,
    },
  },

  chunking: {
    maxTokens: 400,
    overlapTokens: 80,
  },

  autoFlush: {
    enabled: false, // disabled by default to avoid surprise costs
    thresholdTokens: 40000,
  },

  sessionInjection: {
    enabled: false, // disabled by default for now
    maxSnippets: 5,
    minScore: 0.6,
  },

  sources: [
    "MEMORY.md",
    "sessions/**/*.md",
    "projects/**/*.md",
    "skills/**/*.md",
  ],
};
