import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export type PromptScope = "global" | "project";

export interface SavedPrompt {
  id: string;
  name: string;
  content: string;
  scope: PromptScope;
  projectPath?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PromptUpdateFields {
  name?: string;
  content?: string;
}

const COMPANION_DIR = join(homedir(), ".companion");
const PROMPTS_FILE = join(COMPANION_DIR, "prompts.json");

function ensureDir(): void {
  mkdirSync(COMPANION_DIR, { recursive: true });
}

function normalizePath(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "");
}

function loadPrompts(): SavedPrompt[] {
  ensureDir();
  if (!existsSync(PROMPTS_FILE)) return [];
  try {
    const raw = readFileSync(PROMPTS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is SavedPrompt => {
      if (!p || typeof p !== "object") return false;
      const candidate = p as Partial<SavedPrompt>;
      return (
        typeof candidate.id === "string"
        && typeof candidate.name === "string"
        && typeof candidate.content === "string"
        && (candidate.scope === "global" || candidate.scope === "project")
      );
    });
  } catch {
    return [];
  }
}

function savePrompts(prompts: SavedPrompt[]): void {
  ensureDir();
  writeFileSync(PROMPTS_FILE, JSON.stringify(prompts, null, 2), "utf-8");
}

function sortPrompts(prompts: SavedPrompt[]): SavedPrompt[] {
  return [...prompts].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

function visibleForCwd(prompt: SavedPrompt, cwd: string): boolean {
  if (prompt.scope === "global") return true;
  if (!prompt.projectPath) return false;
  const normalizedCwd = normalizePath(cwd);
  const normalizedProject = normalizePath(prompt.projectPath);
  return normalizedCwd === normalizedProject || normalizedCwd.startsWith(`${normalizedProject}/`);
}

export function listPrompts(opts?: { cwd?: string; scope?: "global" | "project" | "all" }): SavedPrompt[] {
  const prompts = loadPrompts();
  const scope = opts?.scope ?? "all";

  const filteredByScope = prompts.filter((p) => {
    if (scope === "all") return true;
    return p.scope === scope;
  });

  if (!opts?.cwd) return sortPrompts(filteredByScope);

  return sortPrompts(filteredByScope.filter((p) => visibleForCwd(p, opts.cwd!)));
}

export function getPrompt(id: string): SavedPrompt | null {
  return loadPrompts().find((p) => p.id === id) ?? null;
}

export function createPrompt(
  name: string,
  content: string,
  scope: PromptScope,
  projectPath?: string,
): SavedPrompt {
  const cleanName = name?.trim();
  const cleanContent = content?.trim();
  if (!cleanName) throw new Error("Prompt name is required");
  if (!cleanContent) throw new Error("Prompt content is required");
  if (scope !== "global" && scope !== "project") throw new Error("Invalid prompt scope");
  if (scope === "project" && !projectPath?.trim()) throw new Error("Project path is required for project prompts");

  const prompts = loadPrompts();
  const now = Date.now();
  const prompt: SavedPrompt = {
    id: crypto.randomUUID(),
    name: cleanName,
    content: cleanContent,
    scope,
    projectPath: scope === "project" ? normalizePath(projectPath!) : undefined,
    createdAt: now,
    updatedAt: now,
  };
  prompts.push(prompt);
  savePrompts(prompts);
  return prompt;
}

export function updatePrompt(id: string, updates: PromptUpdateFields): SavedPrompt | null {
  const prompts = loadPrompts();
  const index = prompts.findIndex((p) => p.id === id);
  if (index < 0) return null;

  if (updates.name !== undefined && !updates.name.trim()) {
    throw new Error("Prompt name cannot be empty");
  }
  if (updates.content !== undefined && !updates.content.trim()) {
    throw new Error("Prompt content cannot be empty");
  }

  const updated: SavedPrompt = {
    ...prompts[index],
    name: updates.name !== undefined ? updates.name.trim() : prompts[index].name,
    content: updates.content !== undefined ? updates.content.trim() : prompts[index].content,
    updatedAt: Date.now(),
  };
  prompts[index] = updated;
  savePrompts(prompts);
  return updated;
}

export function deletePrompt(id: string): boolean {
  const prompts = loadPrompts();
  const next = prompts.filter((p) => p.id !== id);
  if (next.length === prompts.length) return false;
  savePrompts(next);
  return true;
}
