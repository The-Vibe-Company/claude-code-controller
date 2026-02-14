import { vi, type Mock } from "vitest";
import { sendNotification, dispatchNotifications } from "./notification-sender.js";
import type { NotificationProvider, NotificationEvent } from "./notification-types.js";

let mockFetch: Mock;

beforeEach(() => {
  mockFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const testEvent: NotificationEvent = {
  trigger: "session_complete",
  sessionId: "test-session-123",
  sessionName: "Test Session",
  message: "Session completed (5 turns, $0.0123)",
};

function makeProvider(
  overrides: Partial<NotificationProvider> & Pick<NotificationProvider, "config">,
): NotificationProvider {
  return {
    id: "test-id",
    type: overrides.config.type,
    name: overrides.name ?? "Test Provider",
    enabled: true,
    triggers: ["session_complete"],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("notification-sender", () => {
  describe("sendNotification", () => {
    it("sends Slack notification with correct URL and body", async () => {
      const provider = makeProvider({
        config: {
          type: "slack",
          webhookUrl: "https://hooks.slack.com/services/test",
          channel: "#alerts",
        },
      });

      const result = await sendNotification(provider, testEvent);
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://hooks.slack.com/services/test",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toContain("[Companion]");
      expect(body.channel).toBe("#alerts");
    });

    it("sends Telegram notification to correct API", async () => {
      const provider = makeProvider({
        config: { type: "telegram", botToken: "123:ABC", chatId: "-100123" },
      });

      const result = await sendNotification(provider, testEvent);
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.telegram.org/bot123:ABC/sendMessage",
        expect.objectContaining({ method: "POST" }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chat_id).toBe("-100123");
    });

    it("sends Discord notification with content field", async () => {
      const provider = makeProvider({
        config: { type: "discord", webhookUrl: "https://discord.com/api/webhooks/test" },
      });

      const result = await sendNotification(provider, testEvent);
      expect(result.success).toBe(true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.content).toContain("[Companion]");
    });

    it("sends Lark notification with correct format", async () => {
      const provider = makeProvider({
        config: { type: "lark", webhookUrl: "https://open.larksuite.com/test" },
      });

      const result = await sendNotification(provider, testEvent);
      expect(result.success).toBe(true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.msg_type).toBe("text");
      expect(body.content.text).toContain("[Companion]");
    });

    it("sends Resend notification with auth header", async () => {
      const provider = makeProvider({
        config: {
          type: "resend",
          apiKey: "re_test123",
          fromAddress: "noreply@test.com",
          toAddresses: ["user@test.com"],
        },
      });

      const result = await sendNotification(provider, testEvent);
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.resend.com/emails",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer re_test123",
          }),
        }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.from).toBe("noreply@test.com");
      expect(body.to).toEqual(["user@test.com"]);
    });

    it("sends Gotify notification with X-Gotify-Key header", async () => {
      const provider = makeProvider({
        config: {
          type: "gotify",
          serverUrl: "https://gotify.example.com",
          appToken: "gotify-token",
          priority: 8,
        },
      });

      const result = await sendNotification(provider, testEvent);
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://gotify.example.com/message",
        expect.objectContaining({
          headers: expect.objectContaining({ "X-Gotify-Key": "gotify-token" }),
        }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.priority).toBe(8);
    });

    it("sends ntfy notification to topic URL with headers", async () => {
      const provider = makeProvider({
        config: {
          type: "ntfy",
          serverUrl: "https://ntfy.sh",
          topic: "companion-alerts",
          accessToken: "ntfy-token",
          priority: 4,
        },
      });

      const result = await sendNotification(provider, testEvent);
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://ntfy.sh/companion-alerts",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer ntfy-token",
            Priority: "4",
            Title: "Companion",
          }),
        }),
      );
    });

    it("sends Pushover notification to API", async () => {
      const provider = makeProvider({
        config: { type: "pushover", userKey: "user123", apiToken: "api123" },
      });

      const result = await sendNotification(provider, testEvent);
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.pushover.net/1/messages.json",
        expect.anything(),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.token).toBe("api123");
      expect(body.user).toBe("user123");
    });

    it("sends Custom webhook with custom method and headers", async () => {
      const provider = makeProvider({
        config: {
          type: "custom",
          webhookUrl: "https://example.com/hook",
          headers: { "X-Custom": "value" },
          method: "POST",
        },
      });

      const result = await sendNotification(provider, testEvent);
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/hook",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "X-Custom": "value" }),
        }),
      );
    });

    it("handles Custom GET method without body", async () => {
      const provider = makeProvider({
        config: {
          type: "custom",
          webhookUrl: "https://example.com/hook",
          headers: {},
          method: "GET",
        },
      });

      const result = await sendNotification(provider, testEvent);
      expect(result.success).toBe(true);
      const callArgs = mockFetch.mock.calls[0][1];
      expect(callArgs.method).toBe("GET");
      expect(callArgs.body).toBeUndefined();
    });

    it("returns error on non-ok response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => "Forbidden",
      });

      const provider = makeProvider({
        config: { type: "slack", webhookUrl: "https://hooks.slack.com/test" },
      });

      const result = await sendNotification(provider, testEvent);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Slack");
      expect(result.error).toContain("403");
    });

    it("returns error on network exception", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const provider = makeProvider({
        config: { type: "slack", webhookUrl: "https://hooks.slack.com/test" },
      });

      const result = await sendNotification(provider, testEvent);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
    });
  });

  describe("dispatchNotifications", () => {
    it("sends to all providers and logs failures without throwing", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "" })
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Server Error" });

      const providers = [
        makeProvider({ name: "Good", config: { type: "slack", webhookUrl: "https://good.com" } }),
        makeProvider({ name: "Bad", config: { type: "discord", webhookUrl: "https://bad.com" } }),
      ];

      await expect(dispatchNotifications(providers, testEvent)).resolves.not.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("handles empty provider list", async () => {
      await expect(dispatchNotifications([], testEvent)).resolves.not.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
