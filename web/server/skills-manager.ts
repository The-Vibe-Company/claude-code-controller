// Skills Manager
//
// Scans, installs, and uninstalls Claude Code / Codex skills.
// Reads from:
//   - Marketplace plugins: ~/.claude/plugins/marketplaces/{name}/plugins/
//   - User skills: ~/.claude/skills/ (Claude) or ~/.codex/skills/ (Codex)
//   - Project skills: .claude/skills/ (Claude) or .agents/skills/ (Codex)
//   - Installed registry: ~/.claude/plugins/installed_plugins.json

import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SkillInfo {
  name: string;
  description: string;
  source: "marketplace" | "user" | "project";
  pluginName?: string;
  type: "skill" | "command" | "agent";
  path: string;
  frontmatter: Record<string, unknown>;
  installed: boolean;
  installedScope?: "user" | "project";
  installedPath?: string;
}

export interface PluginInfo {
  name: string;
  description: string;
  author?: { name: string; email?: string };
  skills: SkillInfo[];
  commands: SkillInfo[];
  agents: SkillInfo[];
  readme?: string;
  installed: boolean;
  installedVersion?: string;
}

export interface SkillsResponse {
  plugins: PluginInfo[];
  userSkills: SkillInfo[];
  projectSkills: SkillInfo[];
}

interface InstalledPluginEntry {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
}

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPluginEntry[]>;
}

// ─── Frontmatter Parser ──────────────────────────────────────────────────────

/**
 * Parse YAML-like frontmatter from a SKILL.md or command .md file.
 * Handles simple key: value pairs and key: [array] syntax.
 * Does not require a full YAML parser.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)---/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const raw = (match[1] || "").trim();
  const body = content.slice(match[0].length).trim();
  const frontmatter: Record<string, unknown> = {};

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value: unknown = trimmed.slice(colonIdx + 1).trim();

    // Handle bracket arrays: [Read, Glob, Grep]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    // Handle booleans
    else if (value === "true") value = true;
    else if (value === "false") value = false;
    // Handle numbers
    else if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
      value = Number(value);
    }
    // Remove surrounding quotes
    else if (
      typeof value === "string" &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

// ─── Filesystem Scanning ──────────────────────────────────────────────────────

/** Read and parse a SKILL.md or command .md file */
function readSkillFile(
  path: string,
  type: SkillInfo["type"],
  source: SkillInfo["source"],
  pluginName?: string,
): SkillInfo | null {
  try {
    const content = readFileSync(path, "utf-8");
    const { frontmatter } = parseFrontmatter(content);

    const name =
      (frontmatter.name as string) ||
      // For skills: directory name; for commands: filename without .md
      (type === "skill"
        ? basename(join(path, ".."))
        : basename(path, ".md"));

    return {
      name,
      description: (frontmatter.description as string) || "",
      source,
      pluginName,
      type,
      path,
      frontmatter,
      installed: false,
    };
  } catch {
    return null;
  }
}

/** Scan a directory for skills (each subdirectory with a SKILL.md) */
function scanSkillsDir(
  dir: string,
  source: SkillInfo["source"],
  pluginName?: string,
): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const skills: SkillInfo[] = [];

  try {
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      const skillMd = join(skillDir, "SKILL.md");
      if (statSync(skillDir).isDirectory() && existsSync(skillMd)) {
        const skill = readSkillFile(skillMd, "skill", source, pluginName);
        if (skill) skills.push(skill);
      }
    }
  } catch {
    // directory not readable
  }

  return skills;
}

/** Scan a directory for commands (.md files directly in the dir) */
function scanCommandsDir(
  dir: string,
  source: SkillInfo["source"],
  pluginName?: string,
): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const commands: SkillInfo[] = [];

  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const cmdPath = join(dir, entry);
      if (statSync(cmdPath).isFile()) {
        const cmd = readSkillFile(cmdPath, "command", source, pluginName);
        if (cmd) commands.push(cmd);
      }
    }
  } catch {
    // directory not readable
  }

  return commands;
}

/** Scan a directory for agents (.md files directly in the dir) */
function scanAgentsDir(
  dir: string,
  source: SkillInfo["source"],
  pluginName?: string,
): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const agents: SkillInfo[] = [];

  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const agentPath = join(dir, entry);
      if (statSync(agentPath).isFile()) {
        const agent = readSkillFile(agentPath, "agent", source, pluginName);
        if (agent) agents.push(agent);
      }
    }
  } catch {
    // directory not readable
  }

  return agents;
}

// ─── Installed Plugins Registry ───────────────────────────────────────────────

function getInstalledPluginsPath(): string {
  return join(homedir(), ".claude", "plugins", "installed_plugins.json");
}

export function getInstalledPlugins(): InstalledPluginsFile {
  const path = getInstalledPluginsPath();
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as InstalledPluginsFile;
  } catch {
    return { version: 2, plugins: {} };
  }
}

function saveInstalledPlugins(data: InstalledPluginsFile): void {
  const path = getInstalledPluginsPath();
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

// ─── Marketplace Scanner ──────────────────────────────────────────────────────

function getMarketplacesDir(): string {
  return join(homedir(), ".claude", "plugins", "marketplaces");
}

export function listMarketplacePlugins(): PluginInfo[] {
  const marketplacesDir = getMarketplacesDir();
  if (!existsSync(marketplacesDir)) return [];

  const installed = getInstalledPlugins();
  const plugins: PluginInfo[] = [];

  try {
    for (const marketplace of readdirSync(marketplacesDir)) {
      const pluginsDir = join(marketplacesDir, marketplace, "plugins");
      if (!existsSync(pluginsDir)) continue;

      for (const pluginDir of readdirSync(pluginsDir)) {
        const pluginPath = join(pluginsDir, pluginDir);
        if (!statSync(pluginPath).isDirectory()) continue;

        // Read plugin.json manifest
        const manifestPath = join(pluginPath, ".claude-plugin", "plugin.json");
        let name = pluginDir;
        let description = "";
        let author: { name: string; email?: string } | undefined;

        if (existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
            name = manifest.name || pluginDir;
            description = manifest.description || "";
            if (manifest.author) {
              author = {
                name: manifest.author.name || "",
                email: manifest.author.email,
              };
            }
          } catch {
            // malformed manifest
          }
        }

        // Scan sub-directories
        const skills = scanSkillsDir(join(pluginPath, "skills"), "marketplace", name);
        const commands = scanCommandsDir(join(pluginPath, "commands"), "marketplace", name);
        const agents = scanAgentsDir(join(pluginPath, "agents"), "marketplace", name);

        // Skip plugins with no skills, commands, or agents (e.g. LSP-only plugins)
        if (skills.length === 0 && commands.length === 0 && agents.length === 0) {
          // Check if it has just a README (LSP plugin) — skip for UI
          if (!existsSync(manifestPath)) continue;
        }

        // Read README if present
        let readme: string | undefined;
        const readmePath = join(pluginPath, "README.md");
        if (existsSync(readmePath)) {
          try {
            readme = readFileSync(readmePath, "utf-8");
          } catch {
            // skip
          }
        }

        // Check installation status
        const pluginKey = `${pluginDir}@${marketplace}`;
        const installedEntry = installed.plugins[pluginKey];
        const isInstalled = !!installedEntry && installedEntry.length > 0;

        plugins.push({
          name,
          description,
          author,
          skills,
          commands,
          agents,
          readme,
          installed: isInstalled,
          installedVersion: isInstalled ? installedEntry[0].version : undefined,
        });
      }
    }
  } catch {
    // marketplaces dir not readable
  }

  return plugins;
}

// ─── User & Project Skills ────────────────────────────────────────────────────

function getUserSkillsDir(): string {
  return join(homedir(), ".claude", "skills");
}

function getCodexUserSkillsDir(): string {
  return join(homedir(), ".codex", "skills");
}

export function listUserSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];

  // Claude Code user skills
  const claudeDir = getUserSkillsDir();
  for (const s of scanSkillsDir(claudeDir, "user")) {
    s.installed = true;
    s.installedScope = "user";
    s.installedPath = join(claudeDir, s.name);
    skills.push(s);
  }

  // Codex user skills
  const codexDir = getCodexUserSkillsDir();
  for (const s of scanSkillsDir(codexDir, "user")) {
    // Avoid duplicates if same skill name exists in both
    if (!skills.some((existing) => existing.name === s.name)) {
      s.installed = true;
      s.installedScope = "user";
      s.installedPath = join(codexDir, s.name);
      skills.push(s);
    }
  }

  return skills;
}

export function listProjectSkills(cwd: string): SkillInfo[] {
  if (!cwd) return [];
  const skills: SkillInfo[] = [];

  // Claude Code project skills
  const claudeDir = join(cwd, ".claude", "skills");
  for (const s of scanSkillsDir(claudeDir, "project")) {
    s.installed = true;
    s.installedScope = "project";
    s.installedPath = join(claudeDir, s.name);
    skills.push(s);
  }

  // Codex project skills
  const codexDir = join(cwd, ".agents", "skills");
  for (const s of scanSkillsDir(codexDir, "project")) {
    if (!skills.some((existing) => existing.name === s.name)) {
      s.installed = true;
      s.installedScope = "project";
      s.installedPath = join(codexDir, s.name);
      skills.push(s);
    }
  }

  return skills;
}

// ─── Install / Uninstall ──────────────────────────────────────────────────────

export interface InstallOpts {
  pluginName: string;
  skillName?: string;
  scope: "user" | "project";
  cwd?: string;
  /** Install for both Claude and Codex. Default: true */
  dualInstall?: boolean;
}

/**
 * Install a skill or entire plugin from the marketplace.
 * If skillName is provided, install just that skill. Otherwise install all skills from the plugin.
 */
export function installSkill(opts: InstallOpts): { installed: string[] } {
  const { pluginName, skillName, scope, cwd, dualInstall = true } = opts;
  // Default cwd for project-level if not provided
  let effectiveCwd = cwd;
  if (scope === "project" && !cwd) {
    effectiveCwd = process.cwd();
  }

  // Find the plugin in the marketplace
  const marketplacesDir = getMarketplacesDir();
  let pluginPath: string | null = null;

  if (existsSync(marketplacesDir)) {
    for (const marketplace of readdirSync(marketplacesDir)) {
      const candidate = join(marketplacesDir, marketplace, "plugins", pluginName);
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        pluginPath = candidate;
        break;
      }
    }
  }

  if (!pluginPath) {
    throw new Error(`Plugin "${pluginName}" not found in marketplace`);
  }

  const installed: string[] = [];
  const targetDirs = getTargetDirs(scope, effectiveCwd, dualInstall);

  if (skillName) {
    // Install a single item — check skills/, commands/, agents/ directories
    const skillDirPath = join(pluginPath, "skills", skillName);
    const cmdFilePath = join(pluginPath, "commands", `${skillName}.md`);
    const agentFilePath = join(pluginPath, "agents", `${skillName}.md`);

    if (existsSync(skillDirPath) && existsSync(join(skillDirPath, "SKILL.md"))) {
      // Skill directory with SKILL.md
      for (const targetDir of targetDirs) {
        const dest = join(targetDir, skillName);
        mkdirSync(dest, { recursive: true });
        cpSync(skillDirPath, dest, { recursive: true });
      }
      installed.push(skillName);
    } else if (existsSync(cmdFilePath)) {
      // Command .md file — wrap in directory with SKILL.md
      for (const targetDir of targetDirs) {
        const dest = join(targetDir, skillName);
        mkdirSync(dest, { recursive: true });
        cpSync(cmdFilePath, join(dest, "SKILL.md"));
      }
      installed.push(skillName);
    } else if (existsSync(agentFilePath)) {
      // Agent .md file — wrap in directory with SKILL.md
      for (const targetDir of targetDirs) {
        const dest = join(targetDir, skillName);
        mkdirSync(dest, { recursive: true });
        cpSync(agentFilePath, join(dest, "SKILL.md"));
      }
      installed.push(skillName);
    } else {
      throw new Error(`Skill "${skillName}" not found in plugin "${pluginName}"`);
    }
  } else {
    // Install all skills, commands, and agents from the plugin
    const skillsDir = join(pluginPath, "skills");
    if (existsSync(skillsDir)) {
      for (const entry of readdirSync(skillsDir)) {
        const entryPath = join(skillsDir, entry);
        if (statSync(entryPath).isDirectory() && existsSync(join(entryPath, "SKILL.md"))) {
          for (const targetDir of targetDirs) {
            const dest = join(targetDir, entry);
            mkdirSync(dest, { recursive: true });
            cpSync(entryPath, dest, { recursive: true });
          }
          installed.push(entry);
        }
      }
    }

    const commandsDir = join(pluginPath, "commands");
    if (existsSync(commandsDir)) {
      for (const entry of readdirSync(commandsDir)) {
        if (!entry.endsWith(".md")) continue;
        const cmdName = basename(entry, ".md");
        for (const targetDir of targetDirs) {
          const dest = join(targetDir, cmdName);
          mkdirSync(dest, { recursive: true });
          cpSync(join(commandsDir, entry), join(dest, "SKILL.md"));
        }
        installed.push(cmdName);
      }
    }

    const agentsDir = join(pluginPath, "agents");
    if (existsSync(agentsDir)) {
      for (const entry of readdirSync(agentsDir)) {
        if (!entry.endsWith(".md")) continue;
        const agentName = basename(entry, ".md");
        for (const targetDir of targetDirs) {
          const dest = join(targetDir, agentName);
          mkdirSync(dest, { recursive: true });
          cpSync(join(agentsDir, entry), join(dest, "SKILL.md"));
        }
        installed.push(agentName);
      }
    }
  }

  return { installed };
}

export function uninstallSkill(opts: {
  name: string;
  scope: "user" | "project";
  cwd?: string;
}): { removed: boolean } {
  const { name, scope, cwd } = opts;
  let removed = false;

  const dirs =
    scope === "user"
      ? [getUserSkillsDir(), getCodexUserSkillsDir()]
      : cwd
        ? [join(cwd, ".claude", "skills"), join(cwd, ".agents", "skills")]
        : [];

  for (const dir of dirs) {
    const target = join(dir, name);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      removed = true;
    }
  }

  return { removed };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTargetDirs(
  scope: "user" | "project",
  cwd?: string,
  dualInstall = true,
): string[] {
  const dirs: string[] = [];

  if (scope === "user") {
    dirs.push(getUserSkillsDir());
    if (dualInstall) dirs.push(getCodexUserSkillsDir());
  } else if (cwd) {
    dirs.push(join(cwd, ".claude", "skills"));
    if (dualInstall) dirs.push(join(cwd, ".agents", "skills"));
  } else {
    throw new Error("cwd is required for project-level skill installation");
  }

  return dirs;
}

// ─── Main API ─────────────────────────────────────────────────────────────────

export function listAllSkills(cwd?: string): SkillsResponse {
  const plugins = listMarketplacePlugins();
  const userSkills = listUserSkills();
  const projectSkills = cwd ? listProjectSkills(cwd) : [];

  // Mark marketplace skills as installed if they exist in user/project skills
  const installedNames = new Set([
    ...userSkills.map((s) => s.name),
    ...projectSkills.map((s) => s.name),
  ]);

  for (const plugin of plugins) {
    for (const skill of [...plugin.skills, ...plugin.commands, ...plugin.agents]) {
      if (installedNames.has(skill.name)) {
        skill.installed = true;
        const userMatch = userSkills.find((s) => s.name === skill.name);
        const projMatch = projectSkills.find((s) => s.name === skill.name);
        skill.installedScope = userMatch ? "user" : projMatch ? "project" : undefined;
      }
    }
  }

  return { plugins, userSkills, projectSkills };
}
