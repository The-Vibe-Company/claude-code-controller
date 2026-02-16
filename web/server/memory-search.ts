/**
 * Memory Search Engine - hybrid BM25 + vector semantic search
 *
 * Combines:
 * 1. BM25 (keyword) search via SQLite FTS5
 * 2. Vector (semantic) search via cosine similarity
 * 3. Hybrid scoring with configurable weights
 */

import { readFileSync } from "node:fs";
import type {
  MemoryChunk,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryConfig,
  MemorySource,
} from "./memory-types.js";
import { MemoryDatabase } from "./memory-db.js";
import { EmbeddingService, cosineSimilarity } from "./memory-embeddings.js";
import { formatCitation } from "./memory-chunker.js";
import { getMemoryStore } from "./memory-store.js";

// ─── Memory Search Engine ───────────────────────────────────────────────────

export class MemorySearchEngine {
  private db: MemoryDatabase;
  private embeddings: EmbeddingService;
  private config: MemoryConfig;

  constructor(config: MemoryConfig) {
    const store = getMemoryStore(config.storePath);
    this.db = new MemoryDatabase(store.getDatabasePath());
    this.embeddings = new EmbeddingService({
      provider: config.search.provider,
      model: config.search.model,
      apiKey: config.search.apiKey,
    });
    this.config = config;
  }

  /**
   * Perform hybrid search combining BM25 and vector search.
   */
  async search(options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const limit = options.limit || 10;
    const minScore = options.minScore || 0.0;
    const hybridEnabled = this.config.search.hybrid.enabled;

    // If hybrid search is disabled or provider is disabled, fall back to BM25 only
    if (!hybridEnabled || this.config.search.provider === "disabled") {
      return this.searchBM25Only(options);
    }

    // Perform both searches in parallel
    const [bm25Results, vectorResults] = await Promise.all([
      this.searchBM25(options.query, limit * 2), // Fetch more for better hybrid coverage
      this.searchVector(options.query, limit * 2, options.sources),
    ]);

    // Merge and score
    const merged = this.mergeResults(bm25Results, vectorResults);

    // Filter by minScore and limit
    return merged
      .filter((r) => r.score >= minScore)
      .slice(0, limit);
  }

  /**
   * BM25-only search (fallback when embeddings are disabled).
   */
  private searchBM25Only(options: MemorySearchOptions): MemorySearchResult[] {
    const limit = options.limit || 10;
    const minScore = options.minScore || 0.0;

    const results = this.db.searchBM25(options.query, limit);

    return results
      .map((result) => {
        const chunk = this.db.getChunk(result.chunkId);
        if (!chunk) return null;

        // Filter by source if specified
        if (options.sources && !options.sources.includes(chunk.source)) {
          return null;
        }

        return {
          chunk,
          score: this.normalizeBM25Score(result.score),
          bm25Score: result.score,
          citation: formatCitation(chunk),
        };
      })
      .filter((r): r is MemorySearchResult => r !== null && r.score >= minScore);
  }

  /**
   * Perform BM25 keyword search.
   */
  private searchBM25(query: string, limit: number): Array<{ chunkId: string; score: number }> {
    return this.db.searchBM25(query, limit);
  }

  /**
   * Perform vector semantic search.
   */
  private async searchVector(
    query: string,
    limit: number,
    sources?: MemorySource[],
  ): Promise<Array<{ chunkId: string; score: number }>> {
    // Generate query embedding
    const queryEmbedding = await this.embeddings.generateEmbedding(query);

    // Get all chunks with embeddings
    const chunksWithEmbeddings = this.db.getChunksWithEmbeddings(
      this.config.search.provider,
      this.config.search.model,
    );

    // Filter by source if specified
    const filteredChunks = sources
      ? chunksWithEmbeddings.filter((c) => sources.includes(c.source))
      : chunksWithEmbeddings;

    // Compute similarities
    const similarities = filteredChunks.map((chunk) => ({
      chunkId: chunk.id,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));

    // Sort by score descending and take top-k
    similarities.sort((a, b) => b.score - a.score);
    return similarities.slice(0, limit);
  }

  /**
   * Merge BM25 and vector search results with hybrid scoring.
   */
  private mergeResults(
    bm25Results: Array<{ chunkId: string; score: number }>,
    vectorResults: Array<{ chunkId: string; score: number }>,
  ): MemorySearchResult[] {
    const vectorWeight = this.config.search.hybrid.vectorWeight;
    const bm25Weight = this.config.search.hybrid.bm25Weight;

    // Build maps for quick lookup
    const bm25Map = new Map(bm25Results.map((r) => [r.chunkId, r.score]));
    const vectorMap = new Map(vectorResults.map((r) => [r.chunkId, r.score]));

    // Get all unique chunk IDs
    const allChunkIds = new Set([...bm25Map.keys(), ...vectorMap.keys()]);

    // Compute hybrid scores
    const results: MemorySearchResult[] = [];

    for (const chunkId of allChunkIds) {
      const chunk = this.db.getChunk(chunkId);
      if (!chunk) continue;

      const bm25Score = bm25Map.get(chunkId) || 0;
      const vectorScore = vectorMap.get(chunkId) || 0;

      // Normalize scores (BM25 scores need normalization, vector scores are already 0-1)
      const normalizedBM25 = this.normalizeBM25Score(bm25Score);
      const normalizedVector = vectorScore; // Already 0-1

      // Compute hybrid score
      const hybridScore = vectorWeight * normalizedVector + bm25Weight * normalizedBM25;

      results.push({
        chunk,
        score: hybridScore,
        vectorScore: normalizedVector,
        bm25Score: normalizedBM25,
        citation: formatCitation(chunk),
      });
    }

    // Sort by hybrid score descending
    results.sort((a, b) => b.score - a.score);

    return results;
  }

  /**
   * Normalize BM25 scores to 0-1 range.
   * FTS5 rank scores are negative, with lower (more negative) being worse.
   * We convert to positive and normalize.
   */
  private normalizeBM25Score(score: number): number {
    // Simple normalization: clamp to reasonable range and map to 0-1
    // FTS5 scores typically range from 0 to -100+ (lower is worse)
    const maxScore = 50; // Assume scores beyond -50 are very relevant
    const normalized = Math.max(0, Math.min(1, (score + maxScore) / maxScore));
    return normalized;
  }

  /**
   * Close the search engine and database connection.
   */
  close(): void {
    this.db.close();
  }
}

// ─── Indexing Functions ─────────────────────────────────────────────────────

/**
 * Index a single memory file into the database.
 */
export async function indexMemoryFile(
  db: MemoryDatabase,
  embeddings: EmbeddingService,
  config: MemoryConfig,
  file: { path: string; source: MemorySource; absolutePath: string; content: string },
  chunks: MemoryChunk[],
): Promise<void> {
  // Insert chunks into database
  db.upsertChunks(chunks);

  // Generate embeddings if enabled
  if (config.search.provider !== "disabled") {
    for (const chunk of chunks) {
      // Check if we already have this embedding cached
      const cached = db.getCachedEmbedding(
        config.search.provider,
        config.search.model,
        chunk.hash,
      );

      let embedding: number[];
      if (cached) {
        embedding = cached;
      } else {
        // Generate new embedding
        embedding = await embeddings.generateEmbedding(chunk.text);

        // Cache it
        db.cacheEmbedding(
          config.search.provider,
          config.search.model,
          chunk.hash,
          embedding,
        );
      }

      // Store embedding for this chunk
      db.upsertEmbedding(chunk.id, config.search.provider, config.search.model, embedding);
    }
  }
}

/**
 * Re-index all memory files from scratch.
 */
export async function reindexAllMemory(
  config: MemoryConfig,
  onProgress?: (current: number, total: number, file: string) => void,
): Promise<void> {
  const store = getMemoryStore(config.storePath);
  const db = new MemoryDatabase(store.getDatabasePath());
  const embeddings = new EmbeddingService({
    provider: config.search.provider,
    model: config.search.model,
    apiKey: config.search.apiKey,
  });

  // Get all memory files
  const files = store.listMemoryFiles();

  // Clear existing data
  db.clear();

  // Import chunking utilities
  const { chunkMarkdownFile } = await import("./memory-chunker.js");

  // Index each file
  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    if (onProgress) {
      onProgress(i + 1, files.length, file.path);
    }

    try {
      // Read file content
      const content = readFileSync(file.absolutePath, "utf-8");

      // Chunk the file
      const chunks = chunkMarkdownFile(file.path, file.source, content, {
        maxTokens: config.chunking.maxTokens,
        overlapTokens: config.chunking.overlapTokens,
      });

      // Index chunks with embeddings
      await indexMemoryFile(db, embeddings, config, { ...file, content }, chunks);
    } catch (err) {
      console.error(`[memory] Failed to index ${file.path}:`, err);
    }
  }

  db.close();
}

/**
 * Get memory statistics.
 */
export function getMemoryStats(config: MemoryConfig): MemoryStats {
  const store = getMemoryStore(config.storePath);
  const db = new MemoryDatabase(store.getDatabasePath());

  const stats = db.getStats();
  stats.totalFiles = store.listMemoryFiles().length;
  stats.storageSize = store.getStorageSize();

  db.close();
  return stats;
}
