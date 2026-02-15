import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("./settings-manager.js", () => ({
  DEFAULT_OPENROUTER_MODEL: "openrouter/free",
  getSettings: vi.fn(),
}));

import { generateSessionTitle } from "./auto-namer.js";
import * as settingsManager from "./settings-manager.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(settingsManager.getSettings).mockReturnValue({
    openrouterApiKey: "or-key",
    openrouterModel: "openrouter/free",
    updatedAt: 0,
  });
});

describe("generateSessionTitle", () => {
  it("returns parsed title from OpenRouter response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Fix Auth Flow" } }],
      }),
    });

    const title = await generateSessionTitle("Fix login", "claude-sonnet-4-5-20250929");

    expect(title).toBe("Fix Auth Flow");
  });

  it("returns null when OpenRouter key is not configured", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      openrouterApiKey: "",
      openrouterModel: "openrouter/free",
      updatedAt: 0,
    });

    const title = await generateSessionTitle("Fix login", "claude-sonnet-4-5-20250929");

    expect(title).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("truncates message to 500 chars", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Short Title" } }] }),
    });

    await generateSessionTitle("X".repeat(1000), "claude-sonnet-4-5-20250929");

    const [, req] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(req.body)) as { messages: Array<{ role: string; content: string }> };
    const user = body.messages.find((m) => m.role === "user");
    expect(user?.content).toContain("Request:");
    expect(user?.content).toContain("X".repeat(500));
    expect(user?.content).not.toContain("X".repeat(501));
  });

  it("uses configured OpenRouter model", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      openrouterApiKey: "or-key",
      openrouterModel: "openai/gpt-4o-mini",
      updatedAt: 0,
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Title" } }] }),
    });

    await generateSessionTitle("Fix login", "ignored");

    const [, req] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(req.body)) as { model: string };
    expect(body.model).toBe("openai/gpt-4o-mini");
  });

  it("returns null when response is non-ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" });

    const title = await generateSessionTitle("Fix login", "claude-sonnet-4-5-20250929");

    expect(title).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network"));

    const title = await generateSessionTitle("Fix login", "claude-sonnet-4-5-20250929");

    expect(title).toBeNull();
  });

  it("strips surrounding quotes from returned title", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "\"Refactor API Layer\"" } }],
      }),
    });

    const title = await generateSessionTitle("Refactor API", "ignored");
    expect(title).toBe("Refactor API Layer");
  });

  it("parses array content blocks from OpenRouter response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: [{ text: "Improve Task Panel" }] } }],
      }),
    });

    const title = await generateSessionTitle("Improve task panel", "ignored");
    expect(title).toBe("Improve Task Panel");
  });

  it("returns null for titles >= 100 chars", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "A".repeat(100) } }],
      }),
    });

    const title = await generateSessionTitle("Do a thing", "ignored");
    expect(title).toBeNull();
  });

  it("uses default model when configured model is empty", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      openrouterApiKey: "or-key",
      openrouterModel: "",
      updatedAt: 0,
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Title" } }] }),
    });

    await generateSessionTitle("Fix login", "ignored");

    const [, req] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(req.body)) as { model: string };
    expect(body.model).toBe("openrouter/free");
  });

  it("calls OpenRouter endpoint with bearer auth header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Title" } }] }),
    });

    await generateSessionTitle("Fix login", "ignored");

    const [url, req] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((req.headers as Record<string, string>).Authorization).toBe("Bearer or-key");
  });
});
