/**
 * Tests for memory chunking functionality
 */

import { describe, it, expect } from "vitest";
import {
  chunkMarkdownFile,
  extractChunk,
  formatCitation,
  parseCitation,
} from "./memory-chunker.js";

describe("memory-chunker", () => {
  describe("chunkMarkdownFile", () => {
    it("should chunk a small file into a single chunk", () => {
      const content = `# Test File

This is a small test file with minimal content.`;

      const chunks = chunkMarkdownFile("test.md", "global", content);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].path).toBe("test.md");
      expect(chunks[0].source).toBe("global");
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].text).toBe(content);
    });

    it("should create multiple chunks for large files", () => {
      // Create a file with ~1000 tokens (4000 characters)
      const lines = [];
      for (let i = 0; i < 100; i++) {
        lines.push(`Line ${i}: This is some content that takes up space in the file.`);
      }
      const content = lines.join("\n");

      const chunks = chunkMarkdownFile("large.md", "session", content, {
        maxTokens: 200, // Small chunks for testing
        overlapTokens: 50,
      });

      expect(chunks.length).toBeGreaterThan(1);

      // Check that chunks have sequential line ranges
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].startLine).toBeGreaterThan(chunks[i - 1].startLine);
      }
    });

    it("should create overlap between chunks", () => {
      const lines = [];
      for (let i = 0; i < 50; i++) {
        lines.push(`Line ${i}: Some content here.`);
      }
      const content = lines.join("\n");

      const chunks = chunkMarkdownFile("overlap.md", "project", content, {
        maxTokens: 100,
        overlapTokens: 30,
      });

      if (chunks.length > 1) {
        // Check that there's overlap
        const firstChunkEnd = chunks[0].text.split("\n").slice(-5).join("\n");
        const secondChunkStart = chunks[1].text.split("\n").slice(0, 5).join("\n");

        // Some overlap should exist
        expect(chunks[1].startLine).toBeLessThan(chunks[0].endLine);
      }
    });

    it("should generate stable chunk IDs", () => {
      const content = "# Test\n\nSome content";

      const chunks1 = chunkMarkdownFile("test.md", "global", content);
      const chunks2 = chunkMarkdownFile("test.md", "global", content);

      expect(chunks1[0].id).toBe(chunks2[0].id);
    });

    it("should generate content hashes", () => {
      const content = "# Test\n\nSome content";

      const chunks = chunkMarkdownFile("test.md", "global", content);

      expect(chunks[0].hash).toBeDefined();
      expect(chunks[0].hash).toHaveLength(16); // SHA256 truncated to 16 chars
    });
  });

  describe("extractChunk", () => {
    it("should extract correct line range", () => {
      const content = `Line 1
Line 2
Line 3
Line 4
Line 5`;

      const extracted = extractChunk(content, 2, 4);
      expect(extracted).toBe("Line 2\nLine 3\nLine 4");
    });

    it("should handle boundary cases", () => {
      const content = "Line 1\nLine 2\nLine 3";

      // Start at line 1
      expect(extractChunk(content, 1, 2)).toBe("Line 1\nLine 2");

      // End at last line
      expect(extractChunk(content, 2, 3)).toBe("Line 2\nLine 3");

      // Single line
      expect(extractChunk(content, 2, 2)).toBe("Line 2");
    });

    it("should handle out-of-bounds ranges gracefully", () => {
      const content = "Line 1\nLine 2";

      // Start before first line
      expect(extractChunk(content, 0, 1)).toBe("Line 1");

      // End beyond last line
      expect(extractChunk(content, 1, 100)).toBe("Line 1\nLine 2");
    });
  });

  describe("formatCitation", () => {
    it("should format citation correctly", () => {
      const chunk = {
        id: "test123",
        path: "sessions/2026-02-15.md",
        source: "session" as const,
        startLine: 10,
        endLine: 25,
        hash: "abc123",
        text: "content",
        updatedAt: Date.now(),
      };

      const citation = formatCitation(chunk);
      expect(citation).toBe("sessions/2026-02-15.md:10-25");
    });
  });

  describe("parseCitation", () => {
    it("should parse valid citation", () => {
      const citation = "sessions/2026-02-15.md:10-25";
      const parsed = parseCitation(citation);

      expect(parsed).not.toBeNull();
      expect(parsed?.path).toBe("sessions/2026-02-15.md");
      expect(parsed?.startLine).toBe(10);
      expect(parsed?.endLine).toBe(25);
    });

    it("should handle paths with colons", () => {
      const citation = "C:/Users/test/file.md:5-10";
      const parsed = parseCitation(citation);

      expect(parsed).not.toBeNull();
      expect(parsed?.path).toBe("C:/Users/test/file.md");
      expect(parsed?.startLine).toBe(5);
      expect(parsed?.endLine).toBe(10);
    });

    it("should return null for invalid format", () => {
      expect(parseCitation("invalid")).toBeNull();
      expect(parseCitation("file.md")).toBeNull();
      expect(parseCitation("file.md:10")).toBeNull();
      expect(parseCitation("file.md:10-")).toBeNull();
    });

    it("should roundtrip with formatCitation", () => {
      const chunk = {
        id: "test",
        path: "test.md",
        source: "global" as const,
        startLine: 1,
        endLine: 10,
        hash: "hash",
        text: "text",
        updatedAt: Date.now(),
      };

      const citation = formatCitation(chunk);
      const parsed = parseCitation(citation);

      expect(parsed?.path).toBe(chunk.path);
      expect(parsed?.startLine).toBe(chunk.startLine);
      expect(parsed?.endLine).toBe(chunk.endLine);
    });
  });
});
