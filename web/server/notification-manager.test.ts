import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
  getEnabledForTrigger,
  validateConfig,
  _resetForTest,
} from "./notification-manager.js";
import type { ProviderConfig } from "./notification-types.js";

let tempDir: string;
let filePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "notif-manager-test-"));
  filePath = join(tempDir, "notifications.json");
  _resetForTest(filePath);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetForTest();
});

const slackConfig: ProviderConfig = {
  type: "slack",
  webhookUrl: "https://hooks.slack.com/services/test",
};

const telegramConfig: ProviderConfig = {
  type: "telegram",
  botToken: "123:ABC",
  chatId: "-100123",
};

describe("notification-manager", () => {
  describe("listProviders", () => {
    it("returns empty array when no file exists", () => {
      expect(listProviders()).toEqual([]);
    });

    it("returns providers from disk", () => {
      const provider = createProvider("Slack", slackConfig, ["session_complete"]);
      _resetForTest(filePath);
      const loaded = listProviders();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe(provider.id);
      expect(loaded[0].name).toBe("Slack");
    });

    it("handles corrupt JSON gracefully", () => {
      writeFileSync(filePath, "not-valid-json", "utf-8");
      _resetForTest(filePath);
      expect(listProviders()).toEqual([]);
    });

    it("handles non-array JSON gracefully", () => {
      writeFileSync(filePath, JSON.stringify({ foo: "bar" }), "utf-8");
      _resetForTest(filePath);
      expect(listProviders()).toEqual([]);
    });
  });

  describe("createProvider", () => {
    it("creates with correct structure and timestamps", () => {
      const before = Date.now();
      const provider = createProvider("My Slack", slackConfig, ["session_complete", "session_error"]);

      expect(provider.id).toBeTruthy();
      expect(provider.type).toBe("slack");
      expect(provider.name).toBe("My Slack");
      expect(provider.enabled).toBe(true);
      expect(provider.config).toEqual(slackConfig);
      expect(provider.triggers).toEqual(["session_complete", "session_error"]);
      expect(provider.createdAt).toBeGreaterThanOrEqual(before);
      expect(provider.updatedAt).toBeGreaterThanOrEqual(before);
    });

    it("persists to disk as JSON", () => {
      createProvider("Slack", slackConfig, ["session_complete"]);
      const saved = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(saved).toHaveLength(1);
      expect(saved[0].name).toBe("Slack");
    });

    it("writes file with restricted permissions (0600)", () => {
      createProvider("Slack", slackConfig, ["session_complete"]);
      const stats = statSync(filePath);
      // 0o600 = owner read+write only (0x180 = 384 decimal)
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("throws on empty name", () => {
      expect(() => createProvider("", slackConfig, [])).toThrow("Provider name is required");
    });

    it("throws on whitespace-only name", () => {
      expect(() => createProvider("   ", slackConfig, [])).toThrow("Provider name is required");
    });

    it("trims name", () => {
      const p = createProvider("  My Slack  ", slackConfig, []);
      expect(p.name).toBe("My Slack");
    });

    it("respects enabled parameter", () => {
      const p = createProvider("Slack", slackConfig, [], false);
      expect(p.enabled).toBe(false);
    });
  });

  describe("getProvider", () => {
    it("returns provider by ID", () => {
      const created = createProvider("Slack", slackConfig, ["session_complete"]);
      const found = getProvider(created.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Slack");
    });

    it("returns null for nonexistent ID", () => {
      expect(getProvider("nonexistent")).toBeNull();
    });

    it("returns a copy, not a mutable reference to internal state", () => {
      const created = createProvider("Slack", slackConfig, ["session_complete"]);
      const found = getProvider(created.id)!;
      found.name = "Mutated";
      // Internal state should be unchanged
      const foundAgain = getProvider(created.id)!;
      expect(foundAgain.name).toBe("Slack");
    });
  });

  describe("updateProvider", () => {
    it("updates name, config, triggers", () => {
      const created = createProvider("Slack", slackConfig, ["session_complete"]);
      const updated = updateProvider(created.id, {
        name: "Updated Slack",
        config: telegramConfig,
        triggers: ["session_error"],
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Updated Slack");
      expect(updated!.config).toEqual(telegramConfig);
      expect(updated!.type).toBe("telegram");
      expect(updated!.triggers).toEqual(["session_error"]);
    });

    it("preserves createdAt and advances updatedAt", () => {
      const created = createProvider("Slack", slackConfig, []);
      const originalCreatedAt = created.createdAt;

      const updated = updateProvider(created.id, { name: "Renamed" });
      expect(updated!.createdAt).toBe(originalCreatedAt);
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(originalCreatedAt);
    });

    it("returns null for nonexistent ID", () => {
      expect(updateProvider("nonexistent", { name: "x" })).toBeNull();
    });

    it("partial updates keep existing values", () => {
      const created = createProvider("Slack", slackConfig, ["session_complete"]);
      const updated = updateProvider(created.id, { enabled: false });

      expect(updated!.name).toBe("Slack");
      expect(updated!.config).toEqual(slackConfig);
      expect(updated!.triggers).toEqual(["session_complete"]);
      expect(updated!.enabled).toBe(false);
    });

    it("throws on empty name update", () => {
      const created = createProvider("Slack", slackConfig, []);
      expect(() => updateProvider(created.id, { name: "" })).toThrow("Provider name is required");
      expect(() => updateProvider(created.id, { name: "   " })).toThrow("Provider name is required");
    });

    it("validates config on update", () => {
      const created = createProvider("Slack", slackConfig, []);
      expect(() =>
        updateProvider(created.id, {
          config: { type: "slack", webhookUrl: "" } as ProviderConfig,
        }),
      ).toThrow("Slack webhook URL is required");
    });
  });

  describe("deleteProvider", () => {
    it("deletes existing and returns true", () => {
      const created = createProvider("Slack", slackConfig, []);
      expect(deleteProvider(created.id)).toBe(true);
      expect(listProviders()).toHaveLength(0);
    });

    it("returns false for nonexistent", () => {
      expect(deleteProvider("nonexistent")).toBe(false);
    });

    it("persists deletion to disk", () => {
      const created = createProvider("Slack", slackConfig, []);
      deleteProvider(created.id);
      const saved = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(saved).toHaveLength(0);
    });
  });

  describe("getEnabledForTrigger", () => {
    it("returns only enabled providers matching trigger", () => {
      createProvider("Slack", slackConfig, ["session_complete"]);
      createProvider("Telegram", telegramConfig, ["session_error"]);

      const matches = getEnabledForTrigger("session_complete");
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe("Slack");
    });

    it("excludes disabled providers", () => {
      createProvider("Slack", slackConfig, ["session_complete"], false);

      const matches = getEnabledForTrigger("session_complete");
      expect(matches).toHaveLength(0);
    });

    it("returns empty array when no providers match", () => {
      createProvider("Slack", slackConfig, ["session_complete"]);
      expect(getEnabledForTrigger("permission_requested")).toHaveLength(0);
    });

    it("returns multiple matching providers", () => {
      createProvider("Slack", slackConfig, ["session_complete"]);
      createProvider("Telegram", telegramConfig, ["session_complete"]);

      const matches = getEnabledForTrigger("session_complete");
      expect(matches).toHaveLength(2);
    });
  });

  describe("validateConfig", () => {
    it("returns null for valid configs", () => {
      expect(validateConfig(slackConfig)).toBeNull();
      expect(validateConfig(telegramConfig)).toBeNull();
      expect(validateConfig({ type: "discord", webhookUrl: "https://discord.com/hook" })).toBeNull();
      expect(validateConfig({ type: "ntfy", serverUrl: "https://ntfy.sh", topic: "test" })).toBeNull();
      expect(validateConfig({ type: "custom", webhookUrl: "https://example.com", headers: {}, method: "POST" })).toBeNull();
    });

    it("returns error for missing required fields", () => {
      expect(validateConfig({ type: "slack", webhookUrl: "" } as ProviderConfig)).toBe("Slack webhook URL is required");
      expect(validateConfig({ type: "telegram", botToken: "", chatId: "123" } as ProviderConfig)).toBe("Telegram bot token is required");
      expect(validateConfig({ type: "telegram", botToken: "tok", chatId: "" } as ProviderConfig)).toBe("Telegram chat ID is required");
      expect(validateConfig({ type: "gotify", serverUrl: "", appToken: "tok" } as ProviderConfig)).toBe("Gotify server URL is required");
      expect(validateConfig({ type: "pushover", userKey: "", apiToken: "tok" } as ProviderConfig)).toBe("Pushover user key is required");
      expect(validateConfig({ type: "resend", apiKey: "k", fromAddress: "", toAddresses: ["a@b.com"] } as ProviderConfig)).toBe("Resend from address is required");
    });

    it("rejects config with empty webhook URL on create", () => {
      expect(() => createProvider("Bad", { type: "slack", webhookUrl: "" } as ProviderConfig, [])).toThrow("Slack webhook URL is required");
    });
  });
});
