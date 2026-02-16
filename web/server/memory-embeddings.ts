/**
 * Memory Embeddings - embedding generation and caching
 *
 * Supports OpenAI embeddings API with built-in caching.
 * Future: add local embeddings (GGUF), Gemini, Voyage, etc.
 */

import type { EmbeddingProviderConfig } from "./memory-types.js";

// ─── OpenAI Embeddings ──────────────────────────────────────────────────────

const OPENAI_API_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMENSIONS = 1536;

interface OpenAIEmbeddingRequest {
  input: string | string[];
  model: string;
  encoding_format?: "float" | "base64";
  dimensions?: number;
}

interface OpenAIEmbeddingResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * Generate embeddings using OpenAI API.
 */
async function generateOpenAIEmbeddings(
  texts: string[],
  config: EmbeddingProviderConfig,
): Promise<number[][]> {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY or provide in config.");
  }

  const model = config.model || DEFAULT_MODEL;
  const dimensions = config.dimensions || DEFAULT_DIMENSIONS;

  const request: OpenAIEmbeddingRequest = {
    input: texts,
    model,
    encoding_format: "float",
    dimensions,
  };

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${error}`);
  }

  const data = (await response.json()) as OpenAIEmbeddingResponse;

  // Sort by index to ensure correct order
  const sorted = data.data.sort((a, b) => a.index - b.index);
  return sorted.map((item) => item.embedding);
}

// ─── Embedding Service ──────────────────────────────────────────────────────

export class EmbeddingService {
  private config: EmbeddingProviderConfig;
  private cache: Map<string, number[]>;

  constructor(config: EmbeddingProviderConfig) {
    this.config = config;
    this.cache = new Map();
  }

  /**
   * Generate embedding for a single text.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const embeddings = await this.generateEmbeddings([text]);
    return embeddings[0];
  }

  /**
   * Generate embeddings for multiple texts in a single API call.
   * More efficient than calling generateEmbedding multiple times.
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    switch (this.config.provider) {
      case "openai":
        return await generateOpenAIEmbeddings(texts, this.config);

      case "local":
        throw new Error("Local embeddings not yet implemented");

      case "disabled":
        throw new Error("Embeddings are disabled in configuration");

      default:
        throw new Error(`Unknown embedding provider: ${this.config.provider}`);
    }
  }

  /**
   * Generate embeddings with in-memory caching.
   * Useful for repeated queries during a single session.
   */
  async generateEmbeddingCached(text: string): Promise<number[]> {
    const cacheKey = `${this.config.provider}:${this.config.model}:${text}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const embedding = await this.generateEmbedding(text);
    this.cache.set(cacheKey, embedding);
    return embedding;
  }

  /**
   * Clear the in-memory cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}

// ─── Vector Similarity ──────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 * Returns value between -1 and 1, where 1 means identical direction.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have the same dimension");
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Find top-k most similar vectors to a query vector.
 * Returns indices and similarity scores, sorted by score descending.
 */
export function findTopSimilar(
  queryEmbedding: number[],
  candidateEmbeddings: number[][],
  topK: number = 10,
): Array<{ index: number; score: number }> {
  const similarities = candidateEmbeddings.map((embedding, index) => ({
    index,
    score: cosineSimilarity(queryEmbedding, embedding),
  }));

  // Sort by score descending
  similarities.sort((a, b) => b.score - a.score);

  return similarities.slice(0, topK);
}

// ─── Batch Processing ───────────────────────────────────────────────────────

/**
 * Process texts in batches to avoid API rate limits.
 * OpenAI allows up to ~2000 texts per request, but we use smaller batches
 * to avoid timeouts and stay within reasonable token limits.
 */
export async function generateEmbeddingsBatched(
  texts: string[],
  config: EmbeddingProviderConfig,
  batchSize: number = 100,
  onProgress?: (current: number, total: number) => void,
): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const service = new EmbeddingService(config);
    const embeddings = await service.generateEmbeddings(batch);
    results.push(...embeddings);

    if (onProgress) {
      onProgress(Math.min(i + batchSize, texts.length), texts.length);
    }
  }

  return results;
}
