import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TunnelConfig {
  tunnelName: string;
  tunnelId: string;
  hostname: string;
  credentialsFile: string;
  teamDomain: string;
  audienceTag?: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const COMPANION_DIR = join(homedir(), ".companion");
const CONFIG_PATH = join(COMPANION_DIR, "tunnel.json");

function ensureDir(): void {
  mkdirSync(COMPANION_DIR, { recursive: true });
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export function loadConfig(): TunnelConfig | null {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as TunnelConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: TunnelConfig): void {
  ensureDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function deleteConfig(): boolean {
  if (!existsSync(CONFIG_PATH)) return false;
  try {
    unlinkSync(CONFIG_PATH);
    return true;
  } catch {
    return false;
  }
}

export function isConfigured(): boolean {
  return loadConfig() !== null;
}
