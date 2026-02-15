#!/usr/bin/env bun
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Package root so the server can find dist/ regardless of CWD
const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.__COMPANION_PACKAGE_ROOT = resolve(__dirname, "..");

const command = process.argv[2];

function printUsage(): void {
  console.log(`
Usage: the-companion [command]

Commands:
  (none)      Start the server in foreground (default)
  serve       Start the server in foreground
  start       Start the background service
  install     Install as a background service (launchd/systemd)
  stop        Stop the background service
  restart     Restart the background service
  uninstall   Remove the background service
  status      Show service status
  logs        Tail service log files
  help        Show this help message

Options:
  --port <n>  Override the default port (default: 3456)
`);
}

switch (command) {
  case "help":
  case "-h":
  case "--help":
    printUsage();
    break;

  case "serve": {
    process.env.NODE_ENV = process.env.NODE_ENV || "production";
    await import("../server/index.ts");
    break;
  }

  case "start": {
    // Internal service process should stay in foreground server mode.
    const forceForeground = process.argv.includes("--foreground");
    const launchedByInit = (() => {
      if (process.ppid === 1) return true;
      // User-level systemd (systemctl --user) spawns services from a
      // per-user systemd process whose ppid != 1.  Detect it via /proc.
      try {
        const { readFileSync } = require("node:fs");
        const comm = readFileSync(`/proc/${process.ppid}/comm`, "utf-8").trim();
        return comm === "systemd";
      } catch {
        return false;
      }
    })();
    if (forceForeground || launchedByInit) {
      process.env.NODE_ENV = process.env.NODE_ENV || "production";
      await import("../server/index.ts");
      break;
    }
    const { start } = await import("../server/service.js");
    await start();
    break;
  }

  case "install": {
    const { install } = await import("../server/service.js");
    const portIdx = process.argv.indexOf("--port");
    const rawPort = portIdx !== -1 ? Number(process.argv[portIdx + 1]) : undefined;
    const port = rawPort && !Number.isNaN(rawPort) ? rawPort : undefined;
    await install({ port });
    break;
  }

  case "uninstall": {
    const { uninstall } = await import("../server/service.js");
    await uninstall();
    break;
  }

  case "status": {
    const { status } = await import("../server/service.js");
    const result = await status();
    if (!result.installed) {
      console.log("The Companion is not installed as a service.");
      console.log("Run: the-companion install");
    } else if (result.running) {
      console.log(`The Companion is running (PID: ${result.pid})`);
      console.log(`  URL: http://localhost:${result.port}`);
    } else {
      console.log("The Companion is installed but not running.");
      console.log("Check logs at ~/.companion/logs/");
    }
    break;
  }

  case "stop": {
    const { stop } = await import("../server/service.js");
    await stop();
    break;
  }

  case "restart": {
    const { restart } = await import("../server/service.js");
    await restart();
    break;
  }

  case "logs": {
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { spawn } = await import("node:child_process");
    const logFile = join(homedir(), ".companion/logs/companion.log");
    const errFile = join(homedir(), ".companion/logs/companion.error.log");
    const { existsSync } = await import("node:fs");
    if (!existsSync(logFile) && !existsSync(errFile)) {
      console.error("No log files found at ~/.companion/logs/");
      console.error("The service may not have been started yet.");
      process.exit(1);
    }
    console.log("Tailing logs from ~/.companion/logs/");
    const tail = spawn("tail", ["-f", logFile, errFile], { stdio: "inherit" });
    tail.on("exit", () => process.exit(0));
    break;
  }

  case undefined: {
    // Default: start server in foreground
    process.env.NODE_ENV = process.env.NODE_ENV || "production";
    await import("../server/index.ts");
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
