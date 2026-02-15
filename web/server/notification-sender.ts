import type {
  NotificationProvider,
  NotificationEvent,
  SlackConfig,
  TelegramConfig,
  DiscordConfig,
  LarkConfig,
  ResendConfig,
  GotifyConfig,
  NtfyConfig,
  PushoverConfig,
  CustomWebhookConfig,
} from "./notification-types.js";

const FETCH_TIMEOUT_MS = 10_000;

export interface SendResult {
  success: boolean;
  error?: string;
}

export async function sendNotification(
  provider: NotificationProvider,
  event: NotificationEvent,
): Promise<SendResult> {
  try {
    switch (provider.config.type) {
      case "slack":
        return await sendSlack(provider.config, event);
      case "telegram":
        return await sendTelegram(provider.config, event);
      case "discord":
        return await sendDiscord(provider.config, event);
      case "lark":
        return await sendLark(provider.config, event);
      case "resend":
        return await sendResend(provider.config, event);
      case "gotify":
        return await sendGotify(provider.config, event);
      case "ntfy":
        return await sendNtfy(provider.config, event);
      case "pushover":
        return await sendPushover(provider.config, event);
      case "custom":
        return await sendCustom(provider.config, event);
      default:
        return {
          success: false,
          error: `Unknown provider type: ${(provider.config as { type: string }).type}`,
        };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function formatMessage(event: NotificationEvent): string {
  return `[Companion] ${event.message}`;
}

async function sendSlack(
  config: SlackConfig,
  event: NotificationEvent,
): Promise<SendResult> {
  const body: Record<string, unknown> = { text: formatMessage(event) };
  if (config.channel) body.channel = config.channel;

  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok)
    return { success: false, error: `Slack: ${res.status} ${await res.text()}` };
  return { success: true };
}

async function sendTelegram(
  config: TelegramConfig,
  event: NotificationEvent,
): Promise<SendResult> {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text: formatMessage(event),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text()).replace(config.botToken, "***");
    return { success: false, error: `Telegram: ${res.status} ${body}` };
  }
  return { success: true };
}

async function sendDiscord(
  config: DiscordConfig,
  event: NotificationEvent,
): Promise<SendResult> {
  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: formatMessage(event) }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok)
    return {
      success: false,
      error: `Discord: ${res.status} ${await res.text()}`,
    };
  return { success: true };
}

async function sendLark(
  config: LarkConfig,
  event: NotificationEvent,
): Promise<SendResult> {
  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msg_type: "text",
      content: { text: formatMessage(event) },
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok)
    return { success: false, error: `Lark: ${res.status} ${await res.text()}` };
  return { success: true };
}

async function sendResend(
  config: ResendConfig,
  event: NotificationEvent,
): Promise<SendResult> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      from: config.fromAddress,
      to: config.toAddresses,
      subject: `[Companion] ${event.trigger}: ${event.sessionName || event.sessionId}`,
      text: formatMessage(event),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok)
    return {
      success: false,
      error: `Resend: ${res.status} ${await res.text()}`,
    };
  return { success: true };
}

async function sendGotify(
  config: GotifyConfig,
  event: NotificationEvent,
): Promise<SendResult> {
  const url = `${config.serverUrl.replace(/\/$/, "")}/message`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gotify-Key": config.appToken,
    },
    body: JSON.stringify({
      title: "Companion",
      message: formatMessage(event),
      priority: config.priority ?? 5,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok)
    return {
      success: false,
      error: `Gotify: ${res.status} ${await res.text()}`,
    };
  return { success: true };
}

async function sendNtfy(
  config: NtfyConfig,
  event: NotificationEvent,
): Promise<SendResult> {
  const url = `${config.serverUrl.replace(/\/$/, "")}/${encodeURIComponent(config.topic)}`;
  const headers: Record<string, string> = { Title: "Companion" };
  if (config.accessToken) headers.Authorization = `Bearer ${config.accessToken}`;
  if (config.priority) headers.Priority = String(config.priority);

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: formatMessage(event),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok)
    return { success: false, error: `ntfy: ${res.status} ${await res.text()}` };
  return { success: true };
}

async function sendPushover(
  config: PushoverConfig,
  event: NotificationEvent,
): Promise<SendResult> {
  const res = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: config.apiToken,
      user: config.userKey,
      title: "Companion",
      message: formatMessage(event),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok)
    return {
      success: false,
      error: `Pushover: ${res.status} ${await res.text()}`,
    };
  return { success: true };
}

async function sendCustom(
  config: CustomWebhookConfig,
  event: NotificationEvent,
): Promise<SendResult> {
  const init: RequestInit = {
    method: config.method,
    headers: { "Content-Type": "application/json", ...config.headers },
  };
  if (config.method !== "GET") {
    init.body = JSON.stringify({
      trigger: event.trigger,
      sessionId: event.sessionId,
      sessionName: event.sessionName,
      message: event.message,
      details: event.details,
    });
  }
  init.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(config.webhookUrl, init);
  if (!res.ok)
    return {
      success: false,
      error: `Custom: ${res.status} ${await res.text()}`,
    };
  return { success: true };
}

// ─── Dispatch to all matching providers ─────────────────────────────────────

export async function dispatchNotifications(
  providers: NotificationProvider[],
  event: NotificationEvent,
): Promise<void> {
  const results = await Promise.allSettled(
    providers.map((p) => sendNotification(p, event)),
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (
      r.status === "rejected" ||
      (r.status === "fulfilled" && !r.value.success)
    ) {
      const error =
        r.status === "rejected" ? r.reason : r.value.error;
      console.error(
        `[notification-sender] Failed to send to "${providers[i].name}" (${providers[i].type}):`,
        error,
      );
    }
  }
}
