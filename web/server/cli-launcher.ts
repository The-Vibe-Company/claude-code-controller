import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import type { Subprocess } from "bun";

export interface SdkSessionInfo {
  sessionId: string;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  cwd: string;
  createdAt: number;
}

export interface LaunchOptions {
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
}

/**
 * Manages Claude Code CLI processes launched with --sdk-url.
 * Each session spawns a CLI that connects back to our WebSocket server.
 */
export class CliLauncher {
  private sessions = new Map<string, SdkSessionInfo>();
  private processes = new Map<string, Subprocess>();
  private host: string;
  private port: number;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
  }

  /**
   * Launch a new Claude Code CLI session.
   * The CLI will connect back to ws://{host}:{port}/ws/cli/{sessionId}
   */
  launch(options: LaunchOptions = {}): SdkSessionInfo {
    const sessionId = randomUUID();
    const cwd = options.cwd || process.cwd();

    let binary = options.claudeBinary || "claude";
    if (!binary.startsWith("/")) {
      try {
        binary = execSync(`which ${binary}`, { encoding: "utf-8" }).trim();
      } catch {
        // fall through, hope it's in PATH
      }
    }

    const sdkUrl = `ws://${this.host}:${this.port}/ws/cli/${sessionId}`;

    const args: string[] = [
      "--sdk-url", sdkUrl,
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
    ];

    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.permissionMode) {
      args.push("--permission-mode", options.permissionMode);
    }
    if (options.allowedTools) {
      for (const tool of options.allowedTools) {
        args.push("--allowedTools", tool);
      }
    }

    // -p "" is required for headless mode, but ignored when --sdk-url is used
    args.push("-p", "");

    const info: SdkSessionInfo = {
      sessionId,
      state: "starting",
      model: options.model,
      permissionMode: options.permissionMode,
      cwd,
      createdAt: Date.now(),
    };

    this.sessions.set(sessionId, info);

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      CLAUDECODE: "1",
      ...options.env,
    };

    console.log(`[cli-launcher] Spawning session ${sessionId}: ${binary} ${args.join(" ")}`);

    const proc = Bun.spawn([binary, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Stream stdout/stderr for debugging
    this.pipeOutput(sessionId, proc);

    // Monitor process exit
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Session ${sessionId} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
      }
      this.processes.delete(sessionId);
    });

    return info;
  }

  /**
   * Mark a session as connected (called when CLI establishes WS connection).
   */
  markConnected(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.state === "starting") {
      session.state = "connected";
      console.log(`[cli-launcher] Session ${sessionId} connected via WebSocket`);
    }
  }

  /**
   * Kill a session's CLI process.
   */
  async kill(sessionId: string): Promise<boolean> {
    const proc = this.processes.get(sessionId);
    if (!proc) return false;

    proc.kill("SIGTERM");

    // Wait up to 5s for graceful exit, then force kill
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);

    if (!exited) {
      console.log(`[cli-launcher] Force-killing session ${sessionId}`);
      proc.kill("SIGKILL");
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = "exited";
      session.exitCode = -1;
    }
    this.processes.delete(sessionId);
    return true;
  }

  /**
   * List all sessions (active + recently exited).
   */
  listSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get a specific session.
   */
  getSession(sessionId: string): SdkSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a session exists and is alive (not exited).
   */
  isAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.state !== "exited";
  }

  /**
   * Remove a session from the internal map (after kill or cleanup).
   */
  removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.processes.delete(sessionId);
  }

  /**
   * Remove exited sessions from the list.
   */
  pruneExited(): number {
    let pruned = 0;
    for (const [id, session] of this.sessions) {
      if (session.state === "exited") {
        this.sessions.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Kill all sessions.
   */
  async killAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  private async pipeStream(
    sessionId: string,
    stream: ReadableStream<Uint8Array> | null,
    label: "stdout" | "stderr",
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const log = label === "stdout" ? console.log : console.error;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        if (text.trim()) {
          log(`[session:${sessionId}:${label}] ${text.trimEnd()}`);
        }
      }
    } catch {
      // stream closed
    }
  }

  private pipeOutput(sessionId: string, proc: Subprocess): void {
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (stdout && typeof stdout !== "number") {
      this.pipeStream(sessionId, stdout, "stdout");
    }
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }
  }
}
