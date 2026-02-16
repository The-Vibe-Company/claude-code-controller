/**
 * Tests for memory database functionality
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDatabase } from "./memory-db.js";
import type { MemoryChunk } from "./memory-types.js";

describe("memory-db", () => {
  let tempDir: string;
  let db: MemoryDatabase;

  beforeEach(() => {
    // Create a temporary directory for test database
    tempDir = mkdtempSync(join(tmpdir(), "memory-test-"));
    db = new MemoryDatabase(join(tempDir, "test.db"));
  });

  afterEach(() => {
    // Clean up
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("chunks", () => {
    it("should insert and retrieve a chunk", () => {
      const chunk: MemoryChunk = {
        id: "test123",
        path: "test.md",
        source: "global",
        startLine: 1,
        endLine: 10,
        hash: "abc123",
        text: "Test content",
        updatedAt: Date.now(),
      };

      db.upsertChunk(chunk);
      const retrieved = db.getChunk("test123");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(chunk.id);
      expect(retrieved?.text).toBe(chunk.text);
      expect(retrieved?.source).toBe(chunk.source);
    });

    it("should update existing chunk on upsert", () => {
      const chunk: MemoryChunk = {
        id: "test123",
        path: "test.md",
        source: "global",
        startLine: 1,
        endLine: 10,
        hash: "abc123",
        text: "Original text",
        updatedAt: Date.now(),
      };

      db.upsertChunk(chunk);

      const updated = { ...chunk, text: "Updated text" };
      db.upsertChunk(updated);

      const retrieved = db.getChunk("test123");
      expect(retrieved?.text).toBe("Updated text");
    });

    it("should insert multiple chunks in a transaction", () => {
      const chunks: MemoryChunk[] = [
        {
          id: "chunk1",
          path: "test.md",
          source: "session",
          startLine: 1,
          endLine: 5,
          hash: "hash1",
          text: "Chunk 1",
          updatedAt: Date.now(),
        },
        {
          id: "chunk2",
          path: "test.md",
          source: "session",
          startLine: 6,
          endLine: 10,
          hash: "hash2",
          text: "Chunk 2",
          updatedAt: Date.now(),
        },
      ];

      db.upsertChunks(chunks);

      expect(db.getChunk("chunk1")).not.toBeNull();
      expect(db.getChunk("chunk2")).not.toBeNull();
    });

    it("should get chunks by path", () => {
      const chunks: MemoryChunk[] = [
        {
          id: "chunk1",
          path: "file1.md",
          source: "global",
          startLine: 1,
          endLine: 5,
          hash: "hash1",
          text: "Chunk 1",
          updatedAt: Date.now(),
        },
        {
          id: "chunk2",
          path: "file1.md",
          source: "global",
          startLine: 6,
          endLine: 10,
          hash: "hash2",
          text: "Chunk 2",
          updatedAt: Date.now(),
        },
        {
          id: "chunk3",
          path: "file2.md",
          source: "global",
          startLine: 1,
          endLine: 5,
          hash: "hash3",
          text: "Chunk 3",
          updatedAt: Date.now(),
        },
      ];

      db.upsertChunks(chunks);

      const file1Chunks = db.getChunksByPath("file1.md");
      expect(file1Chunks).toHaveLength(2);
      expect(file1Chunks[0].id).toBe("chunk1");
      expect(file1Chunks[1].id).toBe("chunk2");
    });

    it("should delete chunks by path", () => {
      const chunks: MemoryChunk[] = [
        {
          id: "chunk1",
          path: "file1.md",
          source: "global",
          startLine: 1,
          endLine: 5,
          hash: "hash1",
          text: "Chunk 1",
          updatedAt: Date.now(),
        },
        {
          id: "chunk2",
          path: "file2.md",
          source: "global",
          startLine: 1,
          endLine: 5,
          hash: "hash2",
          text: "Chunk 2",
          updatedAt: Date.now(),
        },
      ];

      db.upsertChunks(chunks);

      const deleted = db.deleteChunksByPath("file1.md");
      expect(deleted).toBe(1);
      expect(db.getChunk("chunk1")).toBeNull();
      expect(db.getChunk("chunk2")).not.toBeNull();
    });

    it("should delete chunks by source", () => {
      const chunks: MemoryChunk[] = [
        {
          id: "chunk1",
          path: "file1.md",
          source: "session",
          startLine: 1,
          endLine: 5,
          hash: "hash1",
          text: "Chunk 1",
          updatedAt: Date.now(),
        },
        {
          id: "chunk2",
          path: "file2.md",
          source: "global",
          startLine: 1,
          endLine: 5,
          hash: "hash2",
          text: "Chunk 2",
          updatedAt: Date.now(),
        },
      ];

      db.upsertChunks(chunks);

      const deleted = db.deleteChunksBySource("session");
      expect(deleted).toBe(1);
      expect(db.getChunk("chunk1")).toBeNull();
      expect(db.getChunk("chunk2")).not.toBeNull();
    });
  });

  describe("embeddings", () => {
    it("should store and retrieve embedding", () => {
      const chunk: MemoryChunk = {
        id: "test123",
        path: "test.md",
        source: "global",
        startLine: 1,
        endLine: 10,
        hash: "abc123",
        text: "Test content",
        updatedAt: Date.now(),
      };

      db.upsertChunk(chunk);

      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
      db.upsertEmbedding("test123", "openai", "text-embedding-3-small", embedding);

      const retrieved = db.getEmbedding("test123");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.provider).toBe("openai");
      expect(retrieved?.model).toBe("text-embedding-3-small");
      expect(retrieved?.embedding).toEqual(embedding);
    });

    it("should get chunks with embeddings", () => {
      const chunks: MemoryChunk[] = [
        {
          id: "chunk1",
          path: "file1.md",
          source: "global",
          startLine: 1,
          endLine: 5,
          hash: "hash1",
          text: "Chunk 1",
          updatedAt: Date.now(),
        },
        {
          id: "chunk2",
          path: "file2.md",
          source: "global",
          startLine: 1,
          endLine: 5,
          hash: "hash2",
          text: "Chunk 2",
          updatedAt: Date.now(),
        },
      ];

      db.upsertChunks(chunks);

      const embedding1 = [0.1, 0.2, 0.3];
      const embedding2 = [0.4, 0.5, 0.6];

      db.upsertEmbedding("chunk1", "openai", "test-model", embedding1);
      db.upsertEmbedding("chunk2", "openai", "test-model", embedding2);

      const withEmbeddings = db.getChunksWithEmbeddings("openai", "test-model");
      expect(withEmbeddings).toHaveLength(2);
      expect(withEmbeddings[0].embedding).toEqual(embedding1);
      expect(withEmbeddings[1].embedding).toEqual(embedding2);
    });
  });

  describe("embedding cache", () => {
    it("should cache and retrieve embedding", () => {
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
      db.cacheEmbedding("openai", "test-model", "hash123", embedding);

      const cached = db.getCachedEmbedding("openai", "test-model", "hash123");
      expect(cached).toEqual(embedding);
    });

    it("should return null for non-existent cache entry", () => {
      const cached = db.getCachedEmbedding("openai", "test-model", "nonexistent");
      expect(cached).toBeNull();
    });

    it("should prune cache to limit", () => {
      // Insert 10 cache entries
      for (let i = 0; i < 10; i++) {
        db.cacheEmbedding("openai", "model", `hash${i}`, [i]);
        // Small delay to ensure different timestamps
        Bun.sleepSync(2);
      }

      // Prune to keep only 5 most recent
      const pruned = db.pruneCacheToLimit(5);
      expect(pruned).toBe(5);

      // Check that we have exactly 5 entries left
      const stats = db.getStats();
      expect(stats.cacheEntries).toBe(5);

      // Most recent should still be there
      expect(db.getCachedEmbedding("openai", "model", "hash9")).not.toBeNull();
      // Oldest should be gone
      expect(db.getCachedEmbedding("openai", "model", "hash0")).toBeNull();
    });
  });

  describe("FTS5 search", () => {
    beforeEach(() => {
      // Insert some test chunks
      const chunks: MemoryChunk[] = [
        {
          id: "chunk1",
          path: "file1.md",
          source: "global",
          startLine: 1,
          endLine: 5,
          hash: "hash1",
          text: "The quick brown fox jumps over the lazy dog",
          updatedAt: Date.now(),
        },
        {
          id: "chunk2",
          path: "file2.md",
          source: "session",
          startLine: 1,
          endLine: 5,
          hash: "hash2",
          text: "A fast orange cat leaps across the sleeping hound",
          updatedAt: Date.now(),
        },
        {
          id: "chunk3",
          path: "file3.md",
          source: "project",
          startLine: 1,
          endLine: 5,
          hash: "hash3",
          text: "Implement memory search with BM25 and vector embeddings",
          updatedAt: Date.now(),
        },
      ];

      db.upsertChunks(chunks);
    });

    it("should find exact keyword matches", () => {
      const results = db.searchBM25("fox", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].chunkId).toBe("chunk1");
    });

    it("should find partial matches", () => {
      const results = db.searchBM25("memory", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].chunkId).toBe("chunk3");
    });

    it("should return limited results", () => {
      const results = db.searchBM25("the", 1);
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it("should return empty results for no matches", () => {
      const results = db.searchBM25("zzzznonexistent", 10);
      expect(results).toHaveLength(0);
    });
  });

  describe("statistics", () => {
    it("should return correct stats", () => {
      const chunks: MemoryChunk[] = [
        {
          id: "chunk1",
          path: "file1.md",
          source: "global",
          startLine: 1,
          endLine: 5,
          hash: "hash1",
          text: "Content 1",
          updatedAt: Date.now(),
        },
        {
          id: "chunk2",
          path: "file2.md",
          source: "session",
          startLine: 1,
          endLine: 5,
          hash: "hash2",
          text: "Content 2",
          updatedAt: Date.now(),
        },
      ];

      db.upsertChunks(chunks);
      db.upsertEmbedding("chunk1", "openai", "model", [0.1, 0.2]);

      const stats = db.getStats();
      expect(stats.totalChunks).toBe(2);
      expect(stats.totalEmbeddings).toBe(1);
      expect(stats.sources.global).toBe(1);
      expect(stats.sources.session).toBe(1);
    });
  });

  describe("clear", () => {
    it("should clear all data", () => {
      const chunk: MemoryChunk = {
        id: "test123",
        path: "test.md",
        source: "global",
        startLine: 1,
        endLine: 10,
        hash: "abc123",
        text: "Test content",
        updatedAt: Date.now(),
      };

      db.upsertChunk(chunk);
      db.upsertEmbedding("test123", "openai", "model", [0.1, 0.2]);
      db.cacheEmbedding("openai", "model", "hash", [0.3, 0.4]);

      db.clear();

      const stats = db.getStats();
      expect(stats.totalChunks).toBe(0);
      expect(stats.totalEmbeddings).toBe(0);
      expect(stats.cacheEntries).toBe(0);
    });
  });
});
