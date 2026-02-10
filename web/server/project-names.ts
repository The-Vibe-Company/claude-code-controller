import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ─── Paths ──────────────────────────────────────────────────────────────────

const DEFAULT_PATH = join(homedir(), ".companion", "project-names.json");

// ─── Store ──────────────────────────────────────────────────────────────────

let names: Record<string, string> = {};
let loaded = false;
let filePath = DEFAULT_PATH;

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      names = JSON.parse(raw) as Record<string, string>;
    }
  } catch {
    names = {};
  }
  loaded = true;
}

function persist(): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(names, null, 2), "utf-8");
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function getName(projectKey: string): string | undefined {
  ensureLoaded();
  return names[projectKey];
}

export function setName(projectKey: string, name: string): void {
  ensureLoaded();
  names[projectKey] = name;
  persist();
}

export function getAllNames(): Record<string, string> {
  ensureLoaded();
  return { ...names };
}

export function removeName(projectKey: string): void {
  ensureLoaded();
  delete names[projectKey];
  persist();
}

/** Reset internal state and optionally set a custom file path (for testing). */
export function _resetForTest(customPath?: string): void {
  names = {};
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
}
