import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let service: typeof import("./service.js");

// ─── Mocks ─────────────────────────────────────────────────────────────────────

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => { dir = d; },
  };
});

const mockExecSync = vi.hoisted(() => {
  return vi.fn<(cmd: string, opts?: object) => string>();
});

const mockPlatform = vi.hoisted(() => {
  let platform = "darwin";
  return {
    get: () => platform,
    set: (p: string) => { platform = p; },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: mockExecSync,
  };
});

// Mock process.platform
const originalPlatform = process.platform;

afterAll(() => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    writable: true,
    configurable: true,
  });
});

// ─── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "service-test-"));
  mockHomedir.set(tempDir);
  mockPlatform.set("darwin");
  mockExecSync.mockReset();

  // Set process.platform AFTER resetting mockPlatform to "darwin"
  Object.defineProperty(process, "platform", {
    value: mockPlatform.get(),
    writable: true,
    configurable: true,
  });

  // Mock process.exit to throw instead of exiting
  vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    throw new Error(`process.exit(${code})`);
  });

  vi.resetModules();
  service = await import("./service.js");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function plistPath(): string {
  return join(tempDir, "Library", "LaunchAgents", "sh.thecompanion.app.plist");
}

function oldPlistPath(): string {
  return join(tempDir, "Library", "LaunchAgents", "co.thevibecompany.companion.plist");
}

function unitPath(): string {
  return join(tempDir, ".config", "systemd", "user", "the-companion.service");
}

function logDir(): string {
  return join(tempDir, ".companion", "logs");
}

// ===========================================================================
// generatePlist
// ===========================================================================
describe("generatePlist", () => {
  it("generates valid XML with the correct label", () => {
    const plist = service.generatePlist({ binPath: "/usr/local/bin/the-companion" });
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain("<string>sh.thecompanion.app</string>");
  });

  it("includes RunAtLoad true", () => {
    const plist = service.generatePlist({ binPath: "/usr/local/bin/the-companion" });
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
  });

  it("includes KeepAlive with SuccessfulExit false", () => {
    const plist = service.generatePlist({ binPath: "/usr/local/bin/the-companion" });
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
  });

  it("uses the provided binary path in ProgramArguments", () => {
    const plist = service.generatePlist({ binPath: "/opt/homebrew/bin/the-companion" });
    expect(plist).toContain("<string>/opt/homebrew/bin/the-companion</string>");
    expect(plist).toContain("<string>start</string>");
  });

  it("uses the default production port when none specified", () => {
    const plist = service.generatePlist({ binPath: "/usr/local/bin/the-companion" });
    expect(plist).toContain("<key>PORT</key>");
    expect(plist).toContain("<string>3456</string>");
  });

  it("uses a custom port when specified", () => {
    const plist = service.generatePlist({ binPath: "/usr/local/bin/the-companion", port: 8080 });
    expect(plist).toContain("<string>8080</string>");
  });

  it("includes NODE_ENV production", () => {
    const plist = service.generatePlist({ binPath: "/usr/local/bin/the-companion" });
    expect(plist).toContain("<key>NODE_ENV</key>");
    expect(plist).toContain("<string>production</string>");
  });

  it("includes PATH with homebrew and bun directories", () => {
    const plist = service.generatePlist({ binPath: "/usr/local/bin/the-companion" });
    expect(plist).toContain("/opt/homebrew/bin");
    expect(plist).toContain(".bun/bin");
  });

  it("includes ThrottleInterval", () => {
    const plist = service.generatePlist({ binPath: "/usr/local/bin/the-companion" });
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("<integer>5</integer>");
  });
});

// ===========================================================================
// generateSystemdUnit
// ===========================================================================
describe("generateSystemdUnit", () => {
  it("generates a valid systemd unit with correct sections", () => {
    const unit = service.generateSystemdUnit({ binPath: "/usr/local/bin/the-companion" });
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
  });

  it("includes the description", () => {
    const unit = service.generateSystemdUnit({ binPath: "/usr/local/bin/the-companion" });
    expect(unit).toContain("Description=The Companion");
  });

  it("uses the provided binary path in ExecStart", () => {
    const unit = service.generateSystemdUnit({ binPath: "/home/user/.bun/bin/the-companion" });
    expect(unit).toContain("ExecStart=/home/user/.bun/bin/the-companion start");
  });

  it("uses the default production port when none specified", () => {
    const unit = service.generateSystemdUnit({ binPath: "/usr/local/bin/the-companion" });
    expect(unit).toContain("Environment=PORT=3456");
  });

  it("uses a custom port when specified", () => {
    const unit = service.generateSystemdUnit({ binPath: "/usr/local/bin/the-companion", port: 8080 });
    expect(unit).toContain("Environment=PORT=8080");
  });

  it("includes NODE_ENV production", () => {
    const unit = service.generateSystemdUnit({ binPath: "/usr/local/bin/the-companion" });
    expect(unit).toContain("Environment=NODE_ENV=production");
  });

  it("includes restart on failure", () => {
    const unit = service.generateSystemdUnit({ binPath: "/usr/local/bin/the-companion" });
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5");
  });

  it("includes PATH with bun and local/bin directories", () => {
    const unit = service.generateSystemdUnit({ binPath: "/usr/local/bin/the-companion" });
    expect(unit).toContain(".bun/bin");
    expect(unit).toContain(".local/bin");
  });

  it("targets default.target for user service", () => {
    const unit = service.generateSystemdUnit({ binPath: "/usr/local/bin/the-companion" });
    expect(unit).toContain("WantedBy=default.target");
  });
});

// ===========================================================================
// install (macOS)
// ===========================================================================
describe("install", () => {
  it("creates log directory and writes plist file", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl load")) return "";
      return "";
    });

    await service.install();

    expect(existsSync(logDir())).toBe(true);
    expect(existsSync(plistPath())).toBe(true);

    const content = readFileSync(plistPath(), "utf-8");
    expect(content).toContain("sh.thecompanion.app");
  });

  it("calls launchctl load with the plist path", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl load")) return "";
      return "";
    });

    await service.install();

    const launchctlCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === "string" && cmd.startsWith("launchctl load"),
    );
    expect(launchctlCall).toBeDefined();
    expect(launchctlCall![0]).toContain(plistPath());
  });

  it("exits with error if already installed", async () => {
    // First install
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl")) return "";
      return "";
    });
    await service.install();

    // Second install should fail
    vi.resetModules();
    service = await import("./service.js");
    await expect(service.install()).rejects.toThrow("process.exit(1)");
  });

  it("exits with error if binary not found globally", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) throw new Error("not found");
      return "";
    });

    await expect(service.install()).rejects.toThrow("process.exit(1)");
  });

  it("uses custom port when provided", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl")) return "";
      return "";
    });

    await service.install({ port: 9000 });

    const content = readFileSync(plistPath(), "utf-8");
    expect(content).toContain("<string>9000</string>");
  });

  it("cleans up plist if launchctl load fails", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl load")) throw new Error("launchctl failed");
      return "";
    });

    await expect(service.install()).rejects.toThrow("process.exit(1)");
    expect(existsSync(plistPath())).toBe(false);
  });

  it("migrates old launchd label before installing", async () => {
    const oldPath = oldPlistPath();
    const launchAgentsDir = join(tempDir, "Library", "LaunchAgents");
    rmSync(launchAgentsDir, { recursive: true, force: true });
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl unload")) return "";
      if (cmd.startsWith("launchctl load")) return "";
      return "";
    });

    // Create a legacy plist to simulate pre-rename installs
    const plist = service.generatePlist({ binPath: "/usr/local/bin/the-companion" })
      .replaceAll("sh.thecompanion.app", "co.thevibecompany.companion");
    mkdirSync(launchAgentsDir, { recursive: true });
    writeFileSync(oldPath, plist, "utf-8");

    await service.install();

    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(plistPath())).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining(`launchctl unload -w "${oldPath}"`),
      expect.any(Object),
    );
  });
});

// ===========================================================================
// install (Linux)
// ===========================================================================
describe("install (linux)", () => {
  beforeEach(async () => {
    mockPlatform.set("linux");
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.resetModules();
    service = await import("./service.js");
  });

  it("creates log directory and writes systemd unit file", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("systemctl")) return "";
      return "";
    });

    await service.install();

    expect(existsSync(logDir())).toBe(true);
    expect(existsSync(unitPath())).toBe(true);

    const content = readFileSync(unitPath(), "utf-8");
    expect(content).toContain("ExecStart=/usr/local/bin/the-companion start");
  });

  it("calls systemctl daemon-reload and enable --now", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("systemctl")) return "";
      return "";
    });

    await service.install();

    const daemonReload = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === "string" && cmd.includes("daemon-reload"),
    );
    expect(daemonReload).toBeDefined();

    const enableCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === "string" && cmd.includes("enable --now"),
    );
    expect(enableCall).toBeDefined();
  });

  it("exits with error if already installed", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("systemctl")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    await expect(service.install()).rejects.toThrow("process.exit(1)");
  });

  it("exits with error if binary not found globally", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) throw new Error("not found");
      return "";
    });

    await expect(service.install()).rejects.toThrow("process.exit(1)");
  });

  it("uses custom port when provided", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("systemctl")) return "";
      return "";
    });

    await service.install({ port: 9000 });

    const content = readFileSync(unitPath(), "utf-8");
    expect(content).toContain("Environment=PORT=9000");
  });

  it("cleans up unit file if systemctl enable fails", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.includes("daemon-reload")) return "";
      if (cmd.includes("enable --now")) throw new Error("systemctl failed");
      return "";
    });

    await expect(service.install()).rejects.toThrow("process.exit(1)");
    expect(existsSync(unitPath())).toBe(false);
  });
});

// ===========================================================================
// uninstall (macOS)
// ===========================================================================
describe("uninstall", () => {
  it("calls launchctl unload and removes plist", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => "");

    await service.uninstall();

    const unloadCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === "string" && cmd.startsWith("launchctl unload"),
    );
    expect(unloadCall).toBeDefined();
    expect(existsSync(plistPath())).toBe(false);
  });

  it("handles not-installed gracefully", async () => {
    // Should not throw
    await service.uninstall();
  });

  it("uninstalls old launchd label when only legacy plist exists", async () => {
    const oldPath = oldPlistPath();
    const launchAgentsDir = join(tempDir, "Library", "LaunchAgents");
    mkdirSync(launchAgentsDir, { recursive: true });
    writeFileSync(oldPath, "<plist/>", "utf-8");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => "");

    await service.uninstall();

    expect(existsSync(oldPath)).toBe(false);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining(`launchctl unload -w "${oldPath}"`),
      expect.any(Object),
    );
  });
});

// ===========================================================================
// uninstall (Linux)
// ===========================================================================
describe("uninstall (linux)", () => {
  beforeEach(async () => {
    mockPlatform.set("linux");
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.resetModules();
    service = await import("./service.js");
  });

  it("calls systemctl disable --now and removes unit file", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("systemctl")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => "");

    await service.uninstall();

    const disableCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === "string" && cmd.includes("disable --now"),
    );
    expect(disableCall).toBeDefined();
    expect(existsSync(unitPath())).toBe(false);
  });

  it("calls daemon-reload after removing unit file", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("systemctl")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => "");

    await service.uninstall();

    const reloadCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === "string" && cmd.includes("daemon-reload"),
    );
    expect(reloadCall).toBeDefined();
  });

  it("handles not-installed gracefully", async () => {
    // Should not throw
    await service.uninstall();
  });
});

// ===========================================================================
// stop (macOS)
// ===========================================================================
describe("stop", () => {
  it("calls launchctl bootout when installed", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => "");

    await service.stop();

    const stopCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === "string" && cmd.startsWith("launchctl bootout"),
    );
    expect(stopCall).toBeDefined();
  });

  it("falls back to launchctl unload when bootout fails", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("launchctl bootout")) throw new Error("bootout failed");
      if (cmd.startsWith("launchctl unload")) return "";
      return "";
    });

    await service.stop();

    const unloadCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === "string" && cmd.startsWith("launchctl unload"),
    );
    expect(unloadCall).toBeDefined();
  });

  it("handles not-installed gracefully", async () => {
    // Should not throw
    await service.stop();
  });
});

// ===========================================================================
// stop (Linux)
// ===========================================================================
describe("stop (linux)", () => {
  beforeEach(async () => {
    mockPlatform.set("linux");
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.resetModules();
    service = await import("./service.js");
  });

  it("calls systemctl stop when installed", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("systemctl")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => "");

    await service.stop();

    const stopCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === "string" && cmd.includes("stop the-companion.service"),
    );
    expect(stopCall).toBeDefined();
  });

  it("handles not-installed gracefully", async () => {
    // Should not throw
    await service.stop();
  });
});

// ===========================================================================
// restart (macOS)
// ===========================================================================
describe("restart", () => {
  it("calls launchctl kickstart when installed", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => "");

    await service.restart();

    const restartCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === "string" && cmd.startsWith("launchctl kickstart -k"),
    );
    expect(restartCall).toBeDefined();
  });

  it("handles not-installed gracefully", async () => {
    // Should not throw
    await service.restart();
  });
});

// ===========================================================================
// restart (Linux)
// ===========================================================================
describe("restart (linux)", () => {
  beforeEach(async () => {
    mockPlatform.set("linux");
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.resetModules();
    service = await import("./service.js");
  });

  it("calls systemctl restart when installed", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("systemctl")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => "");

    await service.restart();

    const restartCall = mockExecSync.mock.calls.find(
      ([cmd]) => typeof cmd === "string" && cmd.includes("restart the-companion.service"),
    );
    expect(restartCall).toBeDefined();
  });

  it("handles not-installed gracefully", async () => {
    // Should not throw
    await service.restart();
  });
});

// ===========================================================================
// status (macOS)
// ===========================================================================
describe("status", () => {
  it("returns installed: false when no plist exists", async () => {
    const result = await service.status();
    expect(result).toEqual({ installed: false, running: false });
  });

  it("returns installed: true, running: true with PID", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl load")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("launchctl list")) {
        return `{\n\t"PID" = 12345;\n\t"Label" = "sh.thecompanion.app";\n}`;
      }
      return "";
    });

    const result = await service.status();
    expect(result.installed).toBe(true);
    expect(result.running).toBe(true);
    expect(result.pid).toBe(12345);
    expect(result.port).toBe(3456);
  });

  it("returns installed: true, running: false when service is loaded but not running", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl load")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("launchctl list")) {
        return `{\n\t"Label" = "sh.thecompanion.app";\n}`;
      }
      return "";
    });

    const result = await service.status();
    expect(result.installed).toBe(true);
    expect(result.running).toBe(false);
  });

  it("reports legacy launchd label as installed and running", async () => {
    const oldPath = oldPlistPath();
    const launchAgentsDir = join(tempDir, "Library", "LaunchAgents");
    mkdirSync(launchAgentsDir, { recursive: true });
    writeFileSync(
      oldPath,
      `
<plist>
<dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>4567</string>
  </dict>
</dict>
</plist>
`,
      "utf-8",
    );
    mockExecSync.mockReset();
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("launchctl list")) {
        return `{\n\t"PID" = 12345;\n\t"Label" = "co.thevibecompany.companion";\n}`;
      }
      return "";
    });

    const result = await service.status();
    expect(result).toEqual({
      installed: true,
      running: true,
      pid: 12345,
      port: 4567,
    });
  });
});

// ===========================================================================
// status (Linux)
// ===========================================================================
describe("status (linux)", () => {
  beforeEach(async () => {
    mockPlatform.set("linux");
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.resetModules();
    service = await import("./service.js");
  });

  it("returns installed: false when no unit file exists", async () => {
    const result = await service.status();
    expect(result).toEqual({ installed: false, running: false });
  });

  it("returns installed: true, running: true with PID", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("systemctl")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("show the-companion.service")) {
        return "ActiveState=active\nMainPID=54321\n";
      }
      return "";
    });

    const result = await service.status();
    expect(result.installed).toBe(true);
    expect(result.running).toBe(true);
    expect(result.pid).toBe(54321);
    expect(result.port).toBe(3456);
  });

  it("returns installed: true, running: false when service is inactive", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("systemctl")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("show the-companion.service")) {
        return "ActiveState=inactive\nMainPID=0\n";
      }
      return "";
    });

    const result = await service.status();
    expect(result.installed).toBe(true);
    expect(result.running).toBe(false);
  });

  it("reads custom port from unit file", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("systemctl")) return "";
      return "";
    });
    await service.install({ port: 7777 });

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("show the-companion.service")) {
        return "ActiveState=active\nMainPID=1234\n";
      }
      return "";
    });

    const result = await service.status();
    expect(result.port).toBe(7777);
  });
});

// ===========================================================================
// isRunningAsService (macOS)
// ===========================================================================
describe("isRunningAsService", () => {
  it("returns false on unsupported platforms", async () => {
    mockPlatform.set("win32");
    Object.defineProperty(process, "platform", { value: "win32" });

    vi.resetModules();
    service = await import("./service.js");

    expect(service.isRunningAsService()).toBe(false);
  });

  it("returns false when no plist exists (macOS)", () => {
    expect(service.isRunningAsService()).toBe(false);
  });

  it("returns true when plist exists and service has a PID", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl load")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("launchctl list")) {
        return `{\n\t"PID" = 12345;\n\t"Label" = "sh.thecompanion.app";\n}`;
      }
      return "";
    });

    expect(service.isRunningAsService()).toBe(true);
  });

  it("returns false when plist exists but no PID (not running)", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl load")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("launchctl list")) {
        return `{\n\t"Label" = "sh.thecompanion.app";\n}`;
      }
      return "";
    });

    expect(service.isRunningAsService()).toBe(false);
  });
});

// ===========================================================================
// isRunningAsService (Linux)
// ===========================================================================
describe("isRunningAsService (linux)", () => {
  beforeEach(async () => {
    mockPlatform.set("linux");
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.resetModules();
    service = await import("./service.js");
  });

  it("returns false when no unit file exists", () => {
    expect(service.isRunningAsService()).toBe(false);
  });

  it("returns true when unit file exists and service is active", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.includes("daemon-reload")) return "";
      if (cmd.includes("enable --now")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("is-active")) {
        return "active\n";
      }
      return "";
    });

    expect(service.isRunningAsService()).toBe(true);
  });

  it("returns false when unit file exists but service is inactive", async () => {
    // Install first
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.includes("daemon-reload")) return "";
      if (cmd.includes("enable --now")) return "";
      return "";
    });
    await service.install();

    vi.resetModules();
    service = await import("./service.js");
    mockExecSync.mockReset();
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("is-active")) {
        throw new Error("inactive");
      }
      return "";
    });

    expect(service.isRunningAsService()).toBe(false);
  });
});

// ===========================================================================
// Platform check
// ===========================================================================
describe("platform check", () => {
  it("exits on unsupported platforms", async () => {
    mockPlatform.set("win32");
    Object.defineProperty(process, "platform", { value: "win32" });

    vi.resetModules();
    service = await import("./service.js");

    await expect(service.install()).rejects.toThrow("process.exit(1)");
  });

  it("allows macOS (darwin)", async () => {
    mockPlatform.set("darwin");
    Object.defineProperty(process, "platform", { value: "darwin" });

    vi.resetModules();
    service = await import("./service.js");

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("launchctl")) return "";
      return "";
    });

    // Should not throw platform error
    await service.install();
    expect(existsSync(plistPath())).toBe(true);
  });

  it("allows Linux", async () => {
    mockPlatform.set("linux");
    Object.defineProperty(process, "platform", { value: "linux" });

    vi.resetModules();
    service = await import("./service.js");

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which")) return "/usr/local/bin/the-companion\n";
      if (cmd.startsWith("systemctl")) return "";
      return "";
    });

    // Should not throw platform error
    await service.install();
    expect(existsSync(unitPath())).toBe(true);
  });
});
