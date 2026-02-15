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

export function validateConfig(config: ProviderConfig): string | null {
  switch (config.type) {
    case "slack":
      if (!config.webhookUrl?.trim()) return "Slack webhook URL is required";
      break;
    case "telegram":
      if (!config.botToken?.trim()) return "Telegram bot token is required";
      if (!config.chatId?.trim()) return "Telegram chat ID is required";
      break;
    case "discord":
      if (!config.webhookUrl?.trim()) return "Discord webhook URL is required";
      break;
    case "lark":
      if (!config.webhookUrl?.trim()) return "Lark webhook URL is required";
      break;
    case "resend":
      if (!config.apiKey?.trim()) return "Resend API key is required";
      if (!config.fromAddress?.trim()) return "Resend from address is required";
      if (!config.toAddresses?.length) return "At least one Resend recipient is required";
      break;
    case "gotify":
      if (!config.serverUrl?.trim()) return "Gotify server URL is required";
      if (!config.appToken?.trim()) return "Gotify app token is required";
      break;
    case "ntfy":
      if (!config.serverUrl?.trim()) return "ntfy server URL is required";
      if (!config.topic?.trim()) return "ntfy topic is required";
      break;
    case "pushover":
      if (!config.userKey?.trim()) return "Pushover user key is required";
      if (!config.apiToken?.trim()) return "Pushover API token is required";
      break;
    case "custom":
      if (!config.webhookUrl?.trim()) return "Custom webhook URL is required";
      break;
  }
  return null;
}

function persist(): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(providers, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function listProviders(): NotificationProvider[] {
  ensureLoaded();
  return [...providers];
}

export function getProvider(id: string): NotificationProvider | null {
  ensureLoaded();
  const found = providers.find((p) => p.id === id);
  return found ? { ...found } : null;
}

export function createProvider(
  name: string,
  config: ProviderConfig,
  triggers: NotificationTrigger[],
  enabled = true,
): NotificationProvider {
  ensureLoaded();
  if (!name?.trim()) throw new Error("Provider name is required");
  const configError = validateConfig(config);
  if (configError) throw new Error(configError);

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

  if (updates.name !== undefined && !updates.name.trim()) {
    throw new Error("Provider name is required");
  }
  if (updates.config) {
    const configError = validateConfig(updates.config);
    if (configError) throw new Error(configError);
  }

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
