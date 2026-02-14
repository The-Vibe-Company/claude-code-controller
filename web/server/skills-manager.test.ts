import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter } from "./skills-manager.js";

// ─── parseFrontmatter tests ──────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  it("parses basic key-value frontmatter", () => {
    const content = `---
name: my-skill
description: A test skill
---

# Hello
Body content here.`;

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.name).toBe("my-skill");
    expect(frontmatter.description).toBe("A test skill");
    expect(body).toBe("# Hello\nBody content here.");
  });

  it("parses boolean values", () => {
    const content = `---
disable-model-invocation: true
user-invocable: false
---
body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter["disable-model-invocation"]).toBe(true);
    expect(frontmatter["user-invocable"]).toBe(false);
  });

  it("parses bracket array values", () => {
    const content = `---
allowed-tools: [Read, Glob, Grep, Bash]
---
body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter["allowed-tools"]).toEqual(["Read", "Glob", "Grep", "Bash"]);
  });

  it("parses numeric values", () => {
    const content = `---
version: 1.0
timeout: 30
---
body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.version).toBe(1.0);
    expect(frontmatter.timeout).toBe(30);
  });

  it("strips surrounding quotes from string values", () => {
    const content = `---
name: "quoted-name"
model: 'sonnet'
---
body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.name).toBe("quoted-name");
    expect(frontmatter.model).toBe("sonnet");
  });

  it("returns empty frontmatter when no --- delimiters", () => {
    const content = "Just a body with no frontmatter";
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toEqual({});
    expect(body).toBe(content);
  });

  it("handles empty frontmatter block", () => {
    const content = `---
---
body only`;

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toEqual({});
    expect(body).toBe("body only");
  });

  it("handles multi-word description with colons", () => {
    // Only the first colon should be treated as the key:value separator
    const content = `---
description: Code review: check for bugs and issues
---
body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.description).toBe("Code review: check for bugs and issues");
  });
});

// ─── Filesystem-based tests (using temp dirs) ────────────────────────────────

describe("skills-manager filesystem operations", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper: create a mock skill directory structure.
   * Creates a skills/skill-name/SKILL.md file in the given base dir.
   */
  function createMockSkill(baseDir: string, skillName: string, frontmatter: string, body = "Instructions") {
    const skillDir = join(baseDir, "skills", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\n${frontmatter}\n---\n\n${body}`,
    );
    return skillDir;
  }

  /**
   * Helper: create a mock command file in a commands/ directory.
   */
  function createMockCommand(baseDir: string, cmdName: string, frontmatter: string, body = "Instructions") {
    const cmdDir = join(baseDir, "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(
      join(cmdDir, `${cmdName}.md`),
      `---\n${frontmatter}\n---\n\n${body}`,
    );
  }

  /**
   * Helper: create a minimal plugin structure in a marketplace directory.
   */
  function createMockPlugin(
    marketplaceDir: string,
    pluginName: string,
    manifest: { name: string; description: string },
  ) {
    const pluginDir = join(marketplaceDir, "plugins", pluginName);
    const metaDir = join(pluginDir, ".claude-plugin");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(
      join(metaDir, "plugin.json"),
      JSON.stringify(manifest),
    );
    return pluginDir;
  }

  it("creates and reads back a skill directory structure", () => {
    // Validates that our mock helpers produce files that parseFrontmatter can read
    const skillDir = createMockSkill(tempDir, "test-skill", 'name: test-skill\ndescription: A test');
    const skillMd = join(skillDir, "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);

    const { readFileSync: read } = require("node:fs");
    const content = read(skillMd, "utf-8");
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.name).toBe("test-skill");
    expect(frontmatter.description).toBe("A test");
  });

  it("creates and reads back a command file", () => {
    createMockCommand(tempDir, "review", 'description: Review code\nallowed-tools: [Read, Grep]');
    const cmdPath = join(tempDir, "commands", "review.md");
    expect(existsSync(cmdPath)).toBe(true);

    const { readFileSync: read } = require("node:fs");
    const content = read(cmdPath, "utf-8");
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.description).toBe("Review code");
    expect(frontmatter["allowed-tools"]).toEqual(["Read", "Grep"]);
  });

  it("creates a valid plugin manifest structure", () => {
    const marketDir = join(tempDir, "marketplace");
    const pluginDir = createMockPlugin(marketDir, "test-plugin", {
      name: "test-plugin",
      description: "Test plugin",
    });
    expect(existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);

    const { readFileSync: read } = require("node:fs");
    const manifest = JSON.parse(read(join(pluginDir, ".claude-plugin", "plugin.json"), "utf-8"));
    expect(manifest.name).toBe("test-plugin");
    expect(manifest.description).toBe("Test plugin");
  });

  it("handles skill with references directory", () => {
    // Skills can have supporting reference files
    const skillDir = createMockSkill(tempDir, "complex-skill", 'name: complex\ndescription: Has refs');
    const refsDir = join(skillDir, "references");
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(join(refsDir, "patterns.md"), "# Patterns\nSome content");

    expect(existsSync(join(refsDir, "patterns.md"))).toBe(true);
  });
});
