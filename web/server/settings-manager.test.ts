import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getSettings,
  updateSettings,
  _resetForTest,
  DEFAULT_OPENROUTER_MODEL,
} from "./settings-manager.js";

let tempDir: string;
let settingsPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "settings-manager-test-"));
  settingsPath = join(tempDir, "settings.json");
  _resetForTest(settingsPath);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetForTest();
});

describe("settings-manager", () => {
  it("returns defaults when file is missing", () => {
    expect(getSettings()).toEqual({
      openrouterApiKey: "",
      openrouterModel: DEFAULT_OPENROUTER_MODEL,
      linearApiKey: "",
      updatedAt: 0,
    });
  });

  it("updates and persists settings", () => {
    const updated = updateSettings({ openrouterApiKey: "or-key" });
    expect(updated.openrouterApiKey).toBe("or-key");
    expect(updated.openrouterModel).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(updated.linearApiKey).toBe("");
    expect(updated.updatedAt).toBeGreaterThan(0);

    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.openrouterApiKey).toBe("or-key");
    expect(saved.openrouterModel).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(saved.linearApiKey).toBe("");
  });

  it("loads existing settings from disk", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        openrouterApiKey: "existing",
        openrouterModel: "openai/gpt-4o-mini",
        linearApiKey: "lin_api_abc",
        updatedAt: 123,
      }),
      "utf-8",
    );

    _resetForTest(settingsPath);

    expect(getSettings()).toEqual({
      openrouterApiKey: "existing",
      openrouterModel: "openai/gpt-4o-mini",
      linearApiKey: "lin_api_abc",
      updatedAt: 123,
    });
  });

  it("falls back to defaults for invalid JSON", () => {
    writeFileSync(settingsPath, "not-json", "utf-8");
    _resetForTest(settingsPath);

    expect(getSettings().openrouterModel).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("updates only model while preserving existing key", () => {
    updateSettings({ openrouterApiKey: "or-key" });
    const updated = updateSettings({ openrouterModel: "openai/gpt-4o-mini" });

    expect(updated.openrouterApiKey).toBe("or-key");
    expect(updated.openrouterModel).toBe("openai/gpt-4o-mini");
    expect(updated.linearApiKey).toBe("");
  });

  it("uses default model when empty model is provided", () => {
    const updated = updateSettings({ openrouterModel: "" });
    expect(updated.openrouterModel).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("normalizes malformed file shape to defaults", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        openrouterApiKey: 123,
        openrouterModel: null,
        linearApiKey: 123,
        updatedAt: "x",
      }),
      "utf-8",
    );
    _resetForTest(settingsPath);

    expect(getSettings()).toEqual({
      openrouterApiKey: "",
      openrouterModel: DEFAULT_OPENROUTER_MODEL,
      linearApiKey: "",
      updatedAt: 0,
    });
  });

  it("updates linear key without touching openrouter settings", () => {
    updateSettings({ openrouterApiKey: "or-key", openrouterModel: "openrouter/free" });
    const updated = updateSettings({ linearApiKey: "lin_api_123" });

    expect(updated.openrouterApiKey).toBe("or-key");
    expect(updated.openrouterModel).toBe("openrouter/free");
    expect(updated.linearApiKey).toBe("lin_api_123");
  });
});
