import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => ""));
const mockExistsSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => false));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: mockExistsSync,
  };
});

import { ContainerManager } from "./container-manager.js";

describe("ContainerManager git auth seeding", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
    // Default: existsSync returns false (no host files)
    mockExistsSync.mockReturnValue(false);
  });

  it("always configures gh as git credential helper when host token lookup fails", () => {
    // Regression guard: copied gh auth files in the container are still valid even
    // when `gh auth token` cannot read host keychain state.
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      if (cmd.includes("gh auth token")) throw new Error("host token unavailable");
      return "";
    });

    const manager = new ContainerManager();
    manager.reseedGitAuth("container123");

    const commands = mockExecSync.mock.calls.map((call) => String(call[0] ?? ""));
    expect(commands.some((cmd) => cmd.includes("gh auth setup-git"))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("gh auth login --with-token"))).toBe(false);
  });

  it("logs in with host token before running gh auth setup-git when token exists", () => {
    // Ordering matters: authenticate first, then wire git credential helper.
    mockExecSync.mockImplementation((...args: unknown[]) => {
      const cmd = String(args[0] ?? "");
      if (cmd.includes("gh auth token")) return "ghp_test_token";
      return "";
    });

    const manager = new ContainerManager();
    manager.reseedGitAuth("container123");

    const commands = mockExecSync.mock.calls.map((call) => String(call[0] ?? ""));
    const loginIndex = commands.findIndex((cmd) => cmd.includes("gh auth login --with-token"));
    const setupGitIndex = commands.findIndex((cmd) => cmd.includes("gh auth setup-git"));

    expect(loginIndex).toBeGreaterThan(-1);
    expect(setupGitIndex).toBeGreaterThan(-1);
    expect(loginIndex).toBeLessThan(setupGitIndex);
  });
});

describe("ContainerManager Codex file seeding", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  it("seeds Codex auth files when /companion-host-codex is available", () => {
    // seedCodexFiles is called internally during createContainer and startContainer.
    // Since we can't call createContainer in a unit test (it needs docker), we
    // test the seeding indirectly via a restart (startContainer).
    // However startContainer also calls docker start, so we test via the public
    // reseedGitAuth path which triggers seedGitAuth but not seedCodexFiles.
    // Instead, verify the command is issued during a docker exec mock.
    mockExecSync.mockImplementation((..._args: unknown[]) => "");

    const manager = new ContainerManager();
    // Access private method via bracket notation for testing
    (manager as unknown as Record<string, (id: string) => void>)["seedCodexFiles"]("container456");

    const commands = mockExecSync.mock.calls.map((call) => String(call[0] ?? ""));
    // Should attempt to copy Codex files from bind mount
    expect(commands.some((cmd) =>
      cmd.includes("/companion-host-codex") && cmd.includes("/root/.codex"),
    )).toBe(true);
  });

  it("copies auth.json, config.toml, and directory seeds for Codex", () => {
    mockExecSync.mockImplementation((..._args: unknown[]) => "");

    const manager = new ContainerManager();
    (manager as unknown as Record<string, (id: string) => void>)["seedCodexFiles"]("container789");

    const commands = mockExecSync.mock.calls.map((call) => String(call[0] ?? ""));
    const seedCmd = commands.find((cmd) => cmd.includes("companion-host-codex"));
    expect(seedCmd).toBeDefined();
    // Verify it copies the expected files
    expect(seedCmd).toContain("auth.json");
    expect(seedCmd).toContain("config.toml");
    expect(seedCmd).toContain("models_cache.json");
    // Verify it copies directories
    expect(seedCmd).toContain("skills");
    expect(seedCmd).toContain("prompts");
    expect(seedCmd).toContain("rules");
  });

  it("does not fail when seedCodexFiles encounters an error", () => {
    // seedCodexFiles is best-effort and should not throw
    mockExecSync.mockImplementation(() => {
      throw new Error("container not running");
    });

    const manager = new ContainerManager();
    expect(() => {
      (manager as unknown as Record<string, (id: string) => void>)["seedCodexFiles"]("container999");
    }).not.toThrow();
  });
});
