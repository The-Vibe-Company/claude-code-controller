import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  NotificationProvider,
  ProviderConfig,
  NotificationTrigger,
} from "./notification-types.js";

const DEFAULT_PATH = join(homedir(), ".companion", "notifications.json");

let loaded = false;
let filePath = DEFAULT_PATH;
let providers: NotificationProvider[] = [];

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      providers = Array.isArray(parsed) ? parsed : [];
    }
  } catch {
    providers = [];
  }
  loaded = true;
}

function persist(): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(providers, null, 2), "utf-8");
}

export function listProviders(): NotificationProvider[] {
  ensureLoaded();
  return [...providers];
}

export function getProvider(id: string): NotificationProvider | null {
  ensureLoaded();
  return providers.find((p) => p.id === id) ?? null;
}

export function createProvider(
  name: string,
  config: ProviderConfig,
  triggers: NotificationTrigger[],
  enabled = true,
): NotificationProvider {
  ensureLoaded();
  if (!name?.trim()) throw new Error("Provider name is required");

  const now = Date.now();
  const provider: NotificationProvider = {
    id: randomUUID(),
    type: config.type,
    name: name.trim(),
    enabled,
    config,
    triggers,
    createdAt: now,
    updatedAt: now,
  };
  providers.push(provider);
  persist();
  return provider;
}

export function updateProvider(
  id: string,
  updates: {
    name?: string;
    enabled?: boolean;
    config?: ProviderConfig;
    triggers?: NotificationTrigger[];
  },
): NotificationProvider | null {
  ensureLoaded();
  const idx = providers.findIndex((p) => p.id === id);
  if (idx === -1) return null;

  const existing = providers[idx];
  providers[idx] = {
    ...existing,
    name: updates.name?.trim() || existing.name,
    enabled: updates.enabled ?? existing.enabled,
    config: updates.config ?? existing.config,
    type: updates.config?.type ?? existing.type,
    triggers: updates.triggers ?? existing.triggers,
    updatedAt: Date.now(),
  };
  persist();
  return { ...providers[idx] };
}

export function deleteProvider(id: string): boolean {
  ensureLoaded();
  const before = providers.length;
  providers = providers.filter((p) => p.id !== id);
  if (providers.length === before) return false;
  persist();
  return true;
}

export function getEnabledForTrigger(
  trigger: NotificationTrigger,
): NotificationProvider[] {
  ensureLoaded();
  return providers.filter((p) => p.enabled && p.triggers.includes(trigger));
}

export function _resetForTest(customPath?: string): void {
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
  providers = [];
}
