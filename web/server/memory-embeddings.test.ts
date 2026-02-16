/**
 * Tests for memory embeddings functionality
 */

import { describe, it, expect } from "vitest";
import { cosineSimilarity, findTopSimilar } from "./memory-embeddings.js";

describe("memory-embeddings", () => {
  describe("cosineSimilarity", () => {
    it("should return 1 for identical vectors", () => {
      const v1 = [1, 2, 3, 4, 5];
      const v2 = [1, 2, 3, 4, 5];

      const similarity = cosineSimilarity(v1, v2);
      expect(similarity).toBeCloseTo(1.0, 5);
    });

    it("should return 0 for orthogonal vectors", () => {
      const v1 = [1, 0, 0];
      const v2 = [0, 1, 0];

      const similarity = cosineSimilarity(v1, v2);
      expect(similarity).toBeCloseTo(0.0, 5);
    });

    it("should return -1 for opposite vectors", () => {
      const v1 = [1, 2, 3];
      const v2 = [-1, -2, -3];

      const similarity = cosineSimilarity(v1, v2);
      expect(similarity).toBeCloseTo(-1.0, 5);
    });

    it("should handle normalized vectors", () => {
      // Normalized vectors (unit length)
      const v1 = [0.6, 0.8, 0];
      const v2 = [0.8, 0.6, 0];

      const similarity = cosineSimilarity(v1, v2);
      expect(similarity).toBeGreaterThan(0);
      expect(similarity).toBeLessThan(1);
    });

    it("should throw error for different dimensions", () => {
      const v1 = [1, 2, 3];
      const v2 = [1, 2];

      expect(() => cosineSimilarity(v1, v2)).toThrow();
    });

    it("should handle zero vectors", () => {
      const v1 = [0, 0, 0];
      const v2 = [1, 2, 3];

      const similarity = cosineSimilarity(v1, v2);
      expect(similarity).toBe(0);
    });

    it("should be commutative", () => {
      const v1 = [1, 2, 3];
      const v2 = [4, 5, 6];

      const sim1 = cosineSimilarity(v1, v2);
      const sim2 = cosineSimilarity(v2, v1);

      expect(sim1).toBeCloseTo(sim2, 10);
    });

    it("should work with high-dimensional vectors", () => {
      // Simulate embeddings (1536 dimensions like OpenAI)
      const v1 = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
      const v2 = Array.from({ length: 1536 }, (_, i) => Math.cos(i));

      const similarity = cosineSimilarity(v1, v2);
      expect(similarity).toBeGreaterThan(-1);
      expect(similarity).toBeLessThan(1);
    });
  });

  describe("findTopSimilar", () => {
    it("should find most similar vectors", () => {
      const query = [1, 0, 0];
      const candidates = [
        [1, 0, 0], // Identical
        [0.9, 0.1, 0], // Very similar
        [0, 1, 0], // Orthogonal
        [-1, 0, 0], // Opposite
      ];

      const results = findTopSimilar(query, candidates, 2);

      expect(results).toHaveLength(2);
      expect(results[0].index).toBe(0); // Identical vector
      expect(results[0].score).toBeCloseTo(1.0, 5);
      expect(results[1].index).toBe(1); // Very similar vector
    });

    it("should sort by score descending", () => {
      const query = [1, 1, 1];
      const candidates = [
        [0.1, 0.1, 0.1],
        [0.9, 0.9, 0.9],
        [0.5, 0.5, 0.5],
      ];

      const results = findTopSimilar(query, candidates, 3);

      expect(results[0].score).toBeGreaterThan(results[1].score);
      expect(results[1].score).toBeGreaterThan(results[2].score);
    });

    it("should limit results to topK", () => {
      const query = [1, 0, 0];
      const candidates = [
        [1, 0, 0],
        [0.9, 0.1, 0],
        [0.8, 0.2, 0],
        [0.7, 0.3, 0],
        [0.6, 0.4, 0],
      ];

      const results = findTopSimilar(query, candidates, 3);
      expect(results).toHaveLength(3);
    });

    it("should handle empty candidates", () => {
      const query = [1, 0, 0];
      const candidates: number[][] = [];

      const results = findTopSimilar(query, candidates, 10);
      expect(results).toHaveLength(0);
    });

    it("should handle topK larger than candidates", () => {
      const query = [1, 0, 0];
      const candidates = [
        [1, 0, 0],
        [0.9, 0.1, 0],
      ];

      const results = findTopSimilar(query, candidates, 10);
      expect(results).toHaveLength(2);
    });

    it("should return correct indices", () => {
      const query = [1, 1, 1];
      const candidates = [
        [0.1, 0.1, 0.1], // index 0
        [0.9, 0.9, 0.9], // index 1
        [0.5, 0.5, 0.5], // index 2
      ];

      const results = findTopSimilar(query, candidates, 3);

      // Should be sorted by similarity: 1, 2, 0
      expect(results[0].index).toBe(1);
      expect(results[1].index).toBe(2);
      expect(results[2].index).toBe(0);
    });
  });

  describe("practical similarity scenarios", () => {
    it("should identify similar semantic embeddings", () => {
      // Simulate embeddings for semantically similar texts
      // In reality these would come from an embedding model
      const query = [0.8, 0.5, 0.3, 0.1]; // "How to deploy the app"
      const candidates = [
        [0.75, 0.52, 0.28, 0.12], // "Deploying the application" - very similar
        [0.1, 0.9, 0.2, 0.4], // "User authentication" - different topic
        [0.82, 0.48, 0.31, 0.09], // "App deployment guide" - very similar
      ];

      const results = findTopSimilar(query, candidates, 2);

      // First two results should be the deployment-related ones
      expect(results[0].index).toBeOneOf([0, 2]);
      expect(results[1].index).toBeOneOf([0, 2]);
      expect(results[0].score).toBeGreaterThan(0.9);
    });

    it("should handle noise in embeddings", () => {
      const query = [0.5, 0.5, 0.5, 0.5];

      // Add small random noise to create slightly different vectors
      const candidates = Array.from({ length: 10 }, () =>
        query.map((v) => v + (Math.random() - 0.5) * 0.1),
      );

      const results = findTopSimilar(query, candidates, 3);

      // All should be relatively similar (> 0.8)
      for (const result of results) {
        expect(result.score).toBeGreaterThan(0.8);
      }
    });
  });
});
