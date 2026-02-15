import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseFrontmatter,
  listMarketplacePlugins,
  listUserSkills,
  listProjectSkills,
  installSkill,
  uninstallSkill,
  listAllSkills,
} from "./skills-manager.js";
import { readFileSync } from "node:fs";

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

  let originalHome: string | undefined;
  beforeEach(() => {
    tempDir = join(tmpdir(), `skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    // Point homedir() to our temp dir for the duration of these tests
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
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

  // ─── Marketplace & install/uninstall tests ─────────────────────────────────

  it("lists marketplace plugins and marks installed state", () => {
    // Create marketplace structure under HOME
    const marketplacesDir = join(process.env.HOME as string, ".claude", "plugins", "marketplaces", "market1");
    const pluginsRoot = join(marketplacesDir, "plugins");
    const pluginDir = join(pluginsRoot, "awesome-plugin");
    const metaDir = join(pluginDir, ".claude-plugin");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "plugin.json"), JSON.stringify({ name: "Awesome", description: "X" }));

    // Add a skill
    const skillsDir = join(pluginDir, "skills");
    const skillDir = join(skillsDir, "do-stuff");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: do-stuff\ndescription: Does stuff\n---\n\nbody`);

    // Ensure not installed initially
    let plugins = listMarketplacePlugins();
    const p = plugins.find((x) => x.name === "Awesome" || x.skills.some((s) => s.name === "do-stuff"));
    expect(p).toBeTruthy();
    expect(p!.installed).toBe(false);

    // Create installed_plugins.json to mark installation
    const installedPath = join(process.env.HOME as string, ".claude", "plugins", "installed_plugins.json");
    mkdirSync(join(installedPath, ".."), { recursive: true });
    writeFileSync(
      installedPath,
      JSON.stringify({ version: 2, plugins: { "awesome-plugin@market1": [{ scope: "user", installPath: "/x", version: "1.0", installedAt: "now", lastUpdated: "now" }] } }),
    );

    plugins = listMarketplacePlugins();
    const p2 = plugins.find((x) => x.name === "Awesome");
    expect(p2).toBeTruthy();
    expect(p2!.installed).toBe(true);
  });

  it("installs and uninstalls a single skill to user and project scopes", () => {
    // Setup marketplace plugin with command and agent
    const marketplacesDir = join(process.env.HOME as string, ".claude", "plugins", "marketplaces", "mkt");
    const pluginDir = join(marketplacesDir, "plugins", "mini-plugin");
    const metaDir = join(pluginDir, ".claude-plugin");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "plugin.json"), JSON.stringify({ name: "mini-plugin", description: "" }));

    // Add command file
    const commandsDir = join(pluginDir, "commands");
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, "say-hello.md"), `---\nname: say-hello\n---\nHi`);

    // Install single command as user-scope
    const res = installSkill({ pluginName: "mini-plugin", skillName: "say-hello", scope: "user", dualInstall: false });
    expect(res.installed).toContain("say-hello");

    // Verify it exists in HOME/.claude/skills
    const userSkillPath = join(process.env.HOME as string, ".claude", "skills", "say-hello", "SKILL.md");
    expect(existsSync(userSkillPath)).toBe(true);

    // Uninstall it (user scope)
    const un = uninstallSkill({ name: "say-hello", scope: "user" });
    expect(un.removed).toBe(true);
    expect(existsSync(userSkillPath)).toBe(false);

    // Now test project-level install: create a fake repo cwd
    const projectCwd = join(tempDir, "proj");
    mkdirSync(projectCwd, { recursive: true });
    const res2 = installSkill({ pluginName: "mini-plugin", skillName: "say-hello", scope: "project", cwd: projectCwd, dualInstall: false });
    expect(res2.installed).toContain("say-hello");
    const projSkillPath = join(projectCwd, ".claude", "skills", "say-hello", "SKILL.md");
    expect(existsSync(projSkillPath)).toBe(true);

    // Uninstall project-level
    const un2 = uninstallSkill({ name: "say-hello", scope: "project", cwd: projectCwd });
    expect(un2.removed).toBe(true);
    expect(existsSync(projSkillPath)).toBe(false);
  });

  it("installs all skills/commands/agents from plugin and listAllSkills marks installed ones", () => {
    // Create plugin with skill, command, and agent
    const marketplacesDir = join(process.env.HOME as string, ".claude", "plugins", "marketplaces", "allmkt");
    const pluginDir = join(marketplacesDir, "plugins", "big-plugin");
    mkdirSync(join(pluginDir, "skills", "alpha"), { recursive: true });
    writeFileSync(join(pluginDir, "skills", "alpha", "SKILL.md"), `---\nname: alpha\n---\n`);
    mkdirSync(join(pluginDir, "commands"), { recursive: true });
    writeFileSync(join(pluginDir, "commands", "beta.md"), `---\nname: beta\n---\n`);
    mkdirSync(join(pluginDir, "agents"), { recursive: true });
    writeFileSync(join(pluginDir, "agents", "gamma.md"), `---\nname: gamma\n---\n`);

    // Install whole plugin to user scope
    const res = installSkill({ pluginName: "big-plugin", scope: "user", dualInstall: false });
    expect(res.installed.sort()).toEqual(["alpha", "beta", "gamma"].sort());

    // listAllSkills should reflect installed user skills
    const all = listAllSkills();
    const installedSet = new Set(all.userSkills.map((s) => s.name));
    expect(installedSet.has("alpha")).toBe(true);

    // cleanup
    uninstallSkill({ name: "alpha", scope: "user" });
    uninstallSkill({ name: "beta", scope: "user" });
    uninstallSkill({ name: "gamma", scope: "user" });
  });

  it("throws when plugin not found", () => {
    expect(() => installSkill({ pluginName: "no-such-plugin", scope: "user" })).toThrow();
  });

  it("throws when requested skillName not present in plugin", () => {
    // Create empty plugin dir
    const marketplacesDir = join(process.env.HOME as string, ".claude", "plugins", "marketplaces", "emptymkt");
    const pluginDir = join(marketplacesDir, "plugins", "empty-plugin");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "empty-plugin" }));

    expect(() => installSkill({ pluginName: "empty-plugin", skillName: "missing", scope: "user" })).toThrow(
      /not found/,
    );
  });

  it("uninstallSkill returns false when nothing removed", () => {
    const res = uninstallSkill({ name: "does-not-exist", scope: "user" });
    expect(res.removed).toBe(false);
  });

  it("listAllSkills marks project-installed skills with project scope", () => {
    // Create plugin with skill
    const marketplacesDir = join(process.env.HOME as string, ".claude", "plugins", "marketplaces", "pmkt");
    const pluginDir = join(marketplacesDir, "plugins", "proj-plugin");
    mkdirSync(join(pluginDir, "skills", "proj-skill"), { recursive: true });
    writeFileSync(join(pluginDir, "skills", "proj-skill", "SKILL.md"), `---\nname: proj-skill\n---\n`);

    // Create project cwd with installed proj-skill
    const projectCwd = join(tempDir, "project-xyz");
    mkdirSync(join(projectCwd, ".claude", "skills", "proj-skill"), { recursive: true });
    writeFileSync(join(projectCwd, ".claude", "skills", "proj-skill", "SKILL.md"), `---\nname: proj-skill\n---\n`);

    const all = listAllSkills(projectCwd);
    // Find plugin and its skill
    const plugin = all.plugins.find((p) => p.skills.some((s) => s.name === "proj-skill"));
    expect(plugin).toBeTruthy();
    const skill = plugin!.skills.find((s) => s.name === "proj-skill");
    expect(skill).toBeTruthy();
    expect(skill!.installed).toBe(true);
    expect(skill!.installedScope).toBe("project");
  });
});
