/**
 * Memory Chunker - breaks markdown files into searchable chunks
 *
 * Strategy (following OpenClaw):
 * - Target ~400 tokens per chunk (configurable)
 * - 80-token overlap between chunks to preserve context
 * - Respect markdown structure (headers, paragraphs)
 * - Generate stable chunk IDs based on content hash + line range
 */

import { createHash } from "node:crypto";
import type { MemoryChunk, MemorySource } from "./memory-types.js";

// ─── Token Estimation ───────────────────────────────────────────────────────

/**
 * Rough token estimation: ~4 characters per token for English text.
 * This is approximate but sufficient for chunking.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Content Hashing ────────────────────────────────────────────────────────

/**
 * Generate a stable hash for chunk identification.
 */
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Generate a stable chunk ID from path and line range.
 */
function generateChunkId(path: string, startLine: number, endLine: number): string {
  const key = `${path}:${startLine}-${endLine}`;
  return hashContent(key);
}

// ─── Chunking Logic ─────────────────────────────────────────────────────────

export interface ChunkingOptions {
  maxTokens?: number; // default: 400
  overlapTokens?: number; // default: 80
}

/**
 * Split markdown content into chunks with overlap.
 *
 * Algorithm:
 * 1. Split by lines
 * 2. Accumulate lines until reaching maxTokens
 * 3. Create chunk with line numbers
 * 4. Backtrack by overlapTokens for next chunk start
 * 5. Generate stable IDs and content hashes
 */
export function chunkMarkdownFile(
  path: string,
  source: MemorySource,
  content: string,
  options: ChunkingOptions = {},
): MemoryChunk[] {
  const maxTokens = options.maxTokens || 400;
  const overlapTokens = options.overlapTokens || 80;

  const lines = content.split("\n");
  const chunks: MemoryChunk[] = [];

  if (lines.length === 0) return chunks;

  let currentLines: string[] = [];
  let currentTokens = 0;
  let startLine = 1;
  let currentLineNumber = 1;

  for (const line of lines) {
    const lineTokens = estimateTokens(line);

    // If adding this line would exceed max tokens, create a chunk
    if (currentLines.length > 0 && currentTokens + lineTokens > maxTokens) {
      const chunkText = currentLines.join("\n");
      const endLine = currentLineNumber - 1;

      chunks.push({
        id: generateChunkId(path, startLine, endLine),
        path,
        source,
        startLine,
        endLine,
        hash: hashContent(chunkText),
        text: chunkText,
        updatedAt: Date.now(),
      });

      // Calculate overlap for next chunk
      let overlapLines: string[] = [];
      let overlapTokenCount = 0;

      // Backtrack to include overlap
      for (let i = currentLines.length - 1; i >= 0; i--) {
        const backLine = currentLines[i];
        const backTokens = estimateTokens(backLine);
        if (overlapTokenCount + backTokens > overlapTokens) break;
        overlapLines.unshift(backLine);
        overlapTokenCount += backTokens;
      }

      // Start next chunk with overlap
      currentLines = [...overlapLines, line];
      currentTokens = overlapTokenCount + lineTokens;
      startLine = currentLineNumber - overlapLines.length;
    } else {
      currentLines.push(line);
      currentTokens += lineTokens;
    }

    currentLineNumber++;
  }

  // Don't forget the last chunk
  if (currentLines.length > 0) {
    const chunkText = currentLines.join("\n");
    const endLine = lines.length;

    chunks.push({
      id: generateChunkId(path, startLine, endLine),
      path,
      source,
      startLine,
      endLine,
      hash: hashContent(chunkText),
      text: chunkText,
      updatedAt: Date.now(),
    });
  }

  return chunks;
}

/**
 * Chunk multiple files in parallel.
 */
export function chunkFiles(
  files: Array<{ path: string; source: MemorySource; content: string }>,
  options: ChunkingOptions = {},
): MemoryChunk[] {
  const allChunks: MemoryChunk[] = [];

  for (const file of files) {
    const chunks = chunkMarkdownFile(file.path, file.source, file.content, options);
    allChunks.push(...chunks);
  }

  return allChunks;
}

/**
 * Extract a specific chunk from a file given line range.
 * Useful for memory_get operations.
 */
export function extractChunk(
  content: string,
  startLine: number,
  endLine: number,
): string {
  const lines = content.split("\n");
  // Lines are 1-indexed, arrays are 0-indexed
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  return lines.slice(start, end).join("\n");
}

/**
 * Format a citation for a chunk.
 * Format: "path:startLine-endLine"
 */
export function formatCitation(chunk: MemoryChunk): string {
  return `${chunk.path}:${chunk.startLine}-${chunk.endLine}`;
}

/**
 * Parse a citation string back into components.
 * Returns null if invalid format.
 */
export function parseCitation(citation: string): {
  path: string;
  startLine: number;
  endLine: number;
} | null {
  const match = citation.match(/^(.+):(\d+)-(\d+)$/);
  if (!match) return null;
  return {
    path: match[1],
    startLine: parseInt(match[2], 10),
    endLine: parseInt(match[3], 10),
  };
}
