import { type Subprocess } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type TunnelConfig } from "./tunnel-config.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TunnelStatus = "stopped" | "starting" | "connected" | "error" | "reconnecting";

export interface TunnelState {
  status: TunnelStatus;
  hostname: string | null;
  connectedAt: number | null;
  error: string | null;
  connections: number;
}

// ─── Manager ────────────────────────────────────────────────────────────────

export class TunnelManager {
  private process: Subprocess | null = null;
  private state: TunnelState = {
    status: "stopped",
    hostname: null,
    connectedAt: null,
    error: null,
    connections: 0,
  };
  private onStateChangeCallback: ((state: TunnelState) => void) | null = null;
  private port: number;

  constructor(port: number) {
    this.port = port;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.process) {
      console.log("[tunnel] Already running, stopping first...");
      await this.stop();
    }

    const config = loadConfig();
    if (!config) {
      throw new Error("Tunnel not configured. Run --tunnel-setup first.");
    }

    this.state = {
      status: "starting",
      hostname: config.hostname,
      connectedAt: null,
      error: null,
      connections: 0,
    };
    this.emitStateChange();

    const yamlPath = this.writeCloudflaredConfig(config);
    console.log(`[tunnel] Starting cloudflared tunnel "${config.tunnelName}" → http://localhost:${this.port}`);

    const proc = Bun.spawn(["cloudflared", "tunnel", "--config", yamlPath, "run"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    this.process = proc;
    this.parseOutput(proc);

    proc.exited.then((exitCode) => {
      console.log(`[tunnel] cloudflared exited with code ${exitCode}`);
      if (this.process === proc) {
        this.process = null;
        if (this.state.status !== "stopped") {
          this.state = {
            ...this.state,
            status: "error",
            error: `cloudflared exited with code ${exitCode}`,
            connections: 0,
          };
          this.emitStateChange();
        }
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    const proc = this.process;
    this.process = null;

    proc.kill("SIGTERM");

    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);

    if (!exited) {
      proc.kill("SIGKILL");
      await proc.exited;
    }

    this.state = {
      status: "stopped",
      hostname: null,
      connectedAt: null,
      error: null,
      connections: 0,
    };
    this.emitStateChange();
    console.log("[tunnel] Stopped");
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  // ── State ───────────────────────────────────────────────────────────────

  getState(): TunnelState {
    return { ...this.state };
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  onStateChange(cb: (state: TunnelState) => void): void {
    this.onStateChangeCallback = cb;
  }

  private emitStateChange(): void {
    this.onStateChangeCallback?.(this.getState());
  }

  // ── Config generation ───────────────────────────────────────────────────

  private writeCloudflaredConfig(config: TunnelConfig): string {
    const yaml = [
      `tunnel: ${config.tunnelId}`,
      `credentials-file: ${config.credentialsFile}`,
      `ingress:`,
      `  - hostname: ${config.hostname}`,
      `    service: http://localhost:${this.port}`,
      `  - service: http_status:404`,
    ].join("\n");

    const tmpPath = join(tmpdir(), "companion-cloudflared.yml");
    writeFileSync(tmpPath, yaml, "utf-8");
    return tmpPath;
  }

  // ── Output parsing ──────────────────────────────────────────────────────

  private async parseOutput(proc: Subprocess): Promise<void> {
    const stderr = proc.stderr;
    if (!stderr || typeof stderr === "number") return;

    const reader = (stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });

        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          console.log(`[tunnel] ${trimmed}`);

          if (trimmed.includes("Registered tunnel connection")) {
            this.state.connections++;
            if (this.state.status !== "connected") {
              this.state.status = "connected";
              this.state.connectedAt = Date.now();
            }
            this.emitStateChange();
          } else if (trimmed.includes("Retrying connection")) {
            this.state.status = "reconnecting";
            this.emitStateChange();
          } else if (trimmed.includes("ERR") && this.state.status === "starting") {
            this.state.error = trimmed;
            this.emitStateChange();
          }
        }
      }
    } catch {
      // Reader closed, process exiting
    }
  }

  // ── Static setup helpers ────────────────────────────────────────────────

  static async checkCloudflaredInstalled(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", "cloudflared"], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  static async runLogin(): Promise<{ success: boolean; error?: string }> {
    try {
      const proc = Bun.spawn(["cloudflared", "tunnel", "login"], {
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        return { success: false, error: `cloudflared tunnel login exited with code ${exitCode}` };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  static async createTunnel(
    name: string,
  ): Promise<{ tunnelId: string; credentialsFile: string } | { error: string }> {
    try {
      const proc = Bun.spawn(["cloudflared", "tunnel", "create", name], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const output = stdout + stderr;

      if (exitCode !== 0) {
        return { error: output.trim() || `Exit code ${exitCode}` };
      }

      // Parse tunnel ID from output: "Created tunnel <name> with id <uuid>"
      const idMatch = output.match(/with id ([a-f0-9-]{36})/);
      if (!idMatch) {
        return { error: `Could not parse tunnel ID from output: ${output}` };
      }

      // Parse credentials file path
      const credMatch = output.match(/Tunnel credentials written to (.+\.json)/);
      const credentialsFile = credMatch?.[1]?.trim() ?? "";

      return { tunnelId: idMatch[1], credentialsFile };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  static async routeDns(
    tunnelName: string,
    hostname: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const proc = Bun.spawn(["cloudflared", "tunnel", "route", "dns", tunnelName, hostname], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        // "already exists" is not an error — the CNAME is already routed
        if (stderr.includes("already exists")) {
          return { success: true };
        }
        return { success: false, error: stderr.trim() || `Exit code ${exitCode}` };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
