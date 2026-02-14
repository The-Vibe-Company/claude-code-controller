// ─── Trigger Events ──────────────────────────────────────────────────────────

export type NotificationTrigger =
  | "session_complete"
  | "session_error"
  | "permission_requested";

// ─── Provider-Specific Configs ───────────────────────────────────────────────

export interface SlackConfig {
  type: "slack";
  webhookUrl: string;
  channel?: string;
}

export interface TelegramConfig {
  type: "telegram";
  botToken: string;
  chatId: string;
}

export interface DiscordConfig {
  type: "discord";
  webhookUrl: string;
}

export interface LarkConfig {
  type: "lark";
  webhookUrl: string;
}

export interface ResendConfig {
  type: "resend";
  apiKey: string;
  fromAddress: string;
  toAddresses: string[];
}

export interface GotifyConfig {
  type: "gotify";
  serverUrl: string;
  appToken: string;
  priority?: number;
}

export interface NtfyConfig {
  type: "ntfy";
  serverUrl: string;
  topic: string;
  accessToken?: string;
  priority?: number;
}

export interface PushoverConfig {
  type: "pushover";
  userKey: string;
  apiToken: string;
}

export interface CustomWebhookConfig {
  type: "custom";
  webhookUrl: string;
  headers: Record<string, string>;
  method: "GET" | "POST" | "PUT";
}

export type ProviderConfig =
  | SlackConfig
  | TelegramConfig
  | DiscordConfig
  | LarkConfig
  | ResendConfig
  | GotifyConfig
  | NtfyConfig
  | PushoverConfig
  | CustomWebhookConfig;

export type ProviderType = ProviderConfig["type"];

// ─── Full Notification Provider Record ───────────────────────────────────────

export interface NotificationProvider {
  id: string;
  type: ProviderType;
  name: string;
  enabled: boolean;
  config: ProviderConfig;
  triggers: NotificationTrigger[];
  createdAt: number;
  updatedAt: number;
}

// ─── Notification Event (passed to the sender) ──────────────────────────────

export interface NotificationEvent {
  trigger: NotificationTrigger;
  sessionId: string;
  sessionName?: string;
  message: string;
  details?: Record<string, unknown>;
}
