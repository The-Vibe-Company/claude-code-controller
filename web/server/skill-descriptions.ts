import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Parse YAML frontmatter description from a markdown file */
function parseFrontmatterDescription(content: string): string | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const frontmatter = match[1];
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  if (!descMatch) return null;
  const raw = descMatch[1].trim();
  return (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")) ? raw.slice(1, -1) : raw;
}

function readDescriptionFromFile(filePath: string): string | null {
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      return parseFrontmatterDescription(content);
    }
  } catch { /* skip unreadable files */ }
  return null;
}

// Read skill descriptions from {claudeDir}/skills/{name}/SKILL.md
export function readSkillDescriptions(skillNames: string[], projectRoots?: string[]): Record<string, string> {
  const descriptions: Record<string, string> = {};
  const dirs = [join(homedir(), ".claude", "skills")];
  if (projectRoots) {
    for (const root of projectRoots) {
      dirs.push(join(root, ".claude", "skills"));
    }
  }

  for (const name of skillNames) {
    for (const skillsDir of dirs) {
      if (!existsSync(skillsDir)) continue;
      const desc = readDescriptionFromFile(join(skillsDir, name, "SKILL.md"));
      if (desc) { descriptions[name] = desc; break; }
    }
  }

  return descriptions;
}

// Read command descriptions from {claudeDir}/commands/{name}.md or {claudeDir}/commands/{dir}/{sub}.md
export function readCommandDescriptions(commandNames: string[], projectRoots?: string[]): Record<string, string> {
  const descriptions: Record<string, string> = {};
  const dirs = [join(homedir(), ".claude", "commands")];
  if (projectRoots) {
    for (const root of projectRoots) {
      dirs.push(join(root, ".claude", "commands"));
    }
  }

  for (const name of commandNames) {
    const colonIdx = name.indexOf(":");
    let desc: string | null = null;
    for (const commandsDir of dirs) {
      if (!existsSync(commandsDir)) continue;
      if (colonIdx !== -1) {
        const dir = name.slice(0, colonIdx);
        const sub = name.slice(colonIdx + 1);
        desc = readDescriptionFromFile(join(commandsDir, dir, `${sub}.md`));
      }
      if (!desc) {
        desc = readDescriptionFromFile(join(commandsDir, `${name}.md`));
      }
      if (desc) break;
    }
    if (desc) descriptions[name] = desc;
  }

  return descriptions;
}

export interface CommandInfo {
  name: string;
  type: "command" | "skill";
  description?: string;
}

/** Scan a single .claude directory for skills and commands */
function discoverFromClaudeDir(claudeDir: string, results: CommandInfo[], seen: Set<string>): void {
  // Discover skills
  const skillsDir = join(claudeDir, "skills");
  if (existsSync(skillsDir)) {
    try {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        seen.add(entry.name);
        const desc = readDescriptionFromFile(join(skillsDir, entry.name, "SKILL.md"));
        results.push({ name: entry.name, type: "skill", description: desc ?? undefined });
      }
    } catch { /* skip */ }
  }

  // Discover commands
  const commandsDir = join(claudeDir, "commands");
  if (existsSync(commandsDir)) {
    try {
      for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const name = entry.name.replace(/\.md$/, "");
          if (seen.has(name)) continue;
          seen.add(name);
          const desc = readDescriptionFromFile(join(commandsDir, entry.name));
          results.push({ name, type: "command", description: desc ?? undefined });
        } else if (entry.isDirectory()) {
          if (!seen.has(entry.name) && !existsSync(join(commandsDir, `${entry.name}.md`))) {
            seen.add(entry.name);
            results.push({ name: entry.name, type: "command" });
          }
          // Subcommands: plan/ → plan:fast, plan:ci
          try {
            for (const sub of readdirSync(join(commandsDir, entry.name), { withFileTypes: true })) {
              if (sub.isFile() && sub.name.endsWith(".md")) {
                const subName = `${entry.name}:${sub.name.replace(/\.md$/, "")}`;
                if (seen.has(subName)) continue;
                seen.add(subName);
                const desc = readDescriptionFromFile(join(commandsDir, entry.name, sub.name));
                results.push({ name: subName, type: "command", description: desc ?? undefined });
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }
}

// Discover commands and skills from user (~/.claude) and project (.claude) scopes
export function discoverAllCommandsAndSkills(projectRoots?: string[]): CommandInfo[] {
  const results: CommandInfo[] = [];
  const seen = new Set<string>();

  // User scope: ~/.claude
  discoverFromClaudeDir(join(homedir(), ".claude"), results, seen);

  // Project scope: {projectRoot}/.claude for each unique project root
  if (projectRoots) {
    for (const root of projectRoots) {
      const projectClaudeDir = join(root, ".claude");
      if (existsSync(projectClaudeDir)) {
        discoverFromClaudeDir(projectClaudeDir, results, seen);
      }
    }
  }

  return results;
}
