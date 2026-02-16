/**
 * Memory Database - SQLite backend for chunks, embeddings, and FTS5
 *
 * Schema design follows OpenClaw:
 * - chunks: stores chunk metadata and text
 * - embeddings: stores vector embeddings with provider/model info
 * - embedding_cache: caches embeddings to avoid recomputation
 * - chunks_fts: FTS5 virtual table for BM25 search
 */

import { Database } from "bun:sqlite";
import type {
  MemoryChunk,
  MemorySource,
  EmbeddingCacheEntry,
  MemoryStats,
} from "./memory-types.js";

// ─── Database Schema ────────────────────────────────────────────────────────

const SCHEMA = `
-- Chunks table: stores all text chunks with metadata
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);

-- Embeddings table: stores vector embeddings for chunks
CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  embedding TEXT NOT NULL,  -- JSON array of floats
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_embeddings_provider ON embeddings(provider, model);

-- Embedding cache: caches embeddings by content hash
CREATE TABLE IF NOT EXISTS embedding_cache (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  hash TEXT NOT NULL,
  embedding TEXT NOT NULL,  -- JSON array of floats
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model, hash)
);

-- FTS5 virtual table for full-text search (BM25)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  chunk_id UNINDEXED,
  content='chunks',
  content_rowid='rowid'
);

-- Triggers to keep FTS5 in sync with chunks table
CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, chunk_id)
  VALUES (new.rowid, new.text, new.id);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE chunk_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE ON chunks BEGIN
  UPDATE chunks_fts SET text = new.text WHERE chunk_id = new.id;
END;
`;

// ─── Database Class ─────────────────────────────────────────────────────────

export class MemoryDatabase {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initialize();
  }

  /**
   * Initialize database schema.
   */
  private initialize(): void {
    this.db.exec(SCHEMA);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  // ─── Chunks ─────────────────────────────────────────────────────────────

  /**
   * Insert or update a chunk.
   */
  upsertChunk(chunk: MemoryChunk): void {
    const stmt = this.db.prepare(`
      INSERT INTO chunks (id, path, source, start_line, end_line, hash, text, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        source = excluded.source,
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        hash = excluded.hash,
        text = excluded.text,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      chunk.id,
      chunk.path,
      chunk.source,
      chunk.startLine,
      chunk.endLine,
      chunk.hash,
      chunk.text,
      chunk.updatedAt,
    );
  }

  /**
   * Insert or update multiple chunks in a transaction.
   */
  upsertChunks(chunks: MemoryChunk[]): void {
    const tx = this.db.transaction((chunksToInsert: MemoryChunk[]) => {
      for (const chunk of chunksToInsert) {
        this.upsertChunk(chunk);
      }
    });

    tx(chunks);
  }

  /**
   * Get a chunk by ID.
   */
  getChunk(chunkId: string): MemoryChunk | null {
    const stmt = this.db.prepare(`
      SELECT id, path, source, start_line, end_line, hash, text, updated_at
      FROM chunks
      WHERE id = ?
    `);

    const row = stmt.get(chunkId) as any;
    if (!row) return null;

    return {
      id: row.id,
      path: row.path,
      source: row.source as MemorySource,
      startLine: row.start_line,
      endLine: row.end_line,
      hash: row.hash,
      text: row.text,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Get all chunks for a specific file path.
   */
  getChunksByPath(path: string): MemoryChunk[] {
    const stmt = this.db.prepare(`
      SELECT id, path, source, start_line, end_line, hash, text, updated_at
      FROM chunks
      WHERE path = ?
      ORDER BY start_line ASC
    `);

    const rows = stmt.all(path) as any[];
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      source: row.source as MemorySource,
      startLine: row.start_line,
      endLine: row.end_line,
      hash: row.hash,
      text: row.text,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Delete chunks by file path.
   */
  deleteChunksByPath(path: string): number {
    const stmt = this.db.prepare(`DELETE FROM chunks WHERE path = ?`);
    const result = stmt.run(path);
    return result.changes;
  }

  /**
   * Delete all chunks for a source type.
   */
  deleteChunksBySource(source: MemorySource): number {
    const stmt = this.db.prepare(`DELETE FROM chunks WHERE source = ?`);
    const result = stmt.run(source);
    return result.changes;
  }

  // ─── Embeddings ─────────────────────────────────────────────────────────

  /**
   * Store an embedding for a chunk.
   */
  upsertEmbedding(
    chunkId: string,
    provider: string,
    model: string,
    embedding: number[],
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO embeddings (chunk_id, provider, model, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        embedding = excluded.embedding,
        updated_at = excluded.updated_at
    `);

    stmt.run(chunkId, provider, model, JSON.stringify(embedding), Date.now());
  }

  /**
   * Get an embedding for a chunk.
   */
  getEmbedding(chunkId: string): { provider: string; model: string; embedding: number[] } | null {
    const stmt = this.db.prepare(`
      SELECT provider, model, embedding
      FROM embeddings
      WHERE chunk_id = ?
    `);

    const row = stmt.get(chunkId) as any;
    if (!row) return null;

    return {
      provider: row.provider,
      model: row.model,
      embedding: JSON.parse(row.embedding),
    };
  }

  /**
   * Get all chunks with embeddings for a specific provider/model.
   */
  getChunksWithEmbeddings(
    provider: string,
    model: string,
  ): Array<MemoryChunk & { embedding: number[] }> {
    const stmt = this.db.prepare(`
      SELECT
        c.id, c.path, c.source, c.start_line, c.end_line, c.hash, c.text, c.updated_at,
        e.embedding
      FROM chunks c
      INNER JOIN embeddings e ON c.id = e.chunk_id
      WHERE e.provider = ? AND e.model = ?
    `);

    const rows = stmt.all(provider, model) as any[];
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      source: row.source as MemorySource,
      startLine: row.start_line,
      endLine: row.end_line,
      hash: row.hash,
      text: row.text,
      updatedAt: row.updated_at,
      embedding: JSON.parse(row.embedding),
    }));
  }

  // ─── Embedding Cache ────────────────────────────────────────────────────

  /**
   * Check cache for an embedding by content hash.
   */
  getCachedEmbedding(
    provider: string,
    model: string,
    hash: string,
  ): number[] | null {
    const stmt = this.db.prepare(`
      SELECT embedding
      FROM embedding_cache
      WHERE provider = ? AND model = ? AND hash = ?
    `);

    const row = stmt.get(provider, model, hash) as any;
    if (!row) return null;
    return JSON.parse(row.embedding);
  }

  /**
   * Store an embedding in the cache.
   */
  cacheEmbedding(
    provider: string,
    model: string,
    hash: string,
    embedding: number[],
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO embedding_cache (provider, model, hash, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, model, hash) DO UPDATE SET
        embedding = excluded.embedding,
        updated_at = excluded.updated_at
    `);

    stmt.run(provider, model, hash, JSON.stringify(embedding), Date.now());
  }

  /**
   * Prune cache entries beyond maxEntries (keep most recent).
   */
  pruneCacheToLimit(maxEntries: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM embedding_cache
      WHERE rowid IN (
        SELECT rowid FROM embedding_cache
        ORDER BY updated_at DESC
        LIMIT -1 OFFSET ?
      )
    `);

    const result = stmt.run(maxEntries);
    return result.changes;
  }

  // ─── FTS5 Search ────────────────────────────────────────────────────────

  /**
   * Perform BM25 full-text search.
   * Returns chunk IDs with BM25 scores.
   */
  searchBM25(query: string, limit: number = 10): Array<{ chunkId: string; score: number }> {
    const stmt = this.db.prepare(`
      SELECT chunk_id, rank
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    const rows = stmt.all(query, limit) as any[];
    return rows.map((row) => ({
      chunkId: row.chunk_id,
      score: -row.rank, // FTS5 rank is negative, invert for positive score
    }));
  }

  // ─── Statistics ─────────────────────────────────────────────────────────

  /**
   * Get memory statistics.
   */
  getStats(): MemoryStats {
    const chunksCount = this.db.prepare(`SELECT COUNT(*) as count FROM chunks`).get() as any;
    const embeddingsCount = this.db.prepare(`SELECT COUNT(*) as count FROM embeddings`).get() as any;
    const cacheCount = this.db.prepare(`SELECT COUNT(*) as count FROM embedding_cache`).get() as any;

    const sourceStats = this.db.prepare(`
      SELECT source, COUNT(*) as count
      FROM chunks
      GROUP BY source
    `).all() as any[];

    const sources = {
      global: 0,
      session: 0,
      project: 0,
      skill: 0,
    };

    for (const row of sourceStats) {
      sources[row.source as MemorySource] = row.count;
    }

    return {
      totalFiles: 0, // Will be set by caller
      totalChunks: chunksCount.count,
      totalEmbeddings: embeddingsCount.count,
      cacheEntries: cacheCount.count,
      lastSync: Date.now(),
      storageSize: 0, // Will be set by caller
      sources,
    };
  }

  /**
   * Clear all data from the database.
   */
  clear(): void {
    this.db.exec(`
      DELETE FROM embedding_cache;
      DELETE FROM embeddings;
      DELETE FROM chunks;
    `);
  }
}
