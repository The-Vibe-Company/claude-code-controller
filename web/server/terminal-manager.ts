import type { ServerWebSocket } from "bun";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { SocketData } from "./ws-bridge.js";

/** Bun's PTY terminal handle exposed on proc when spawned with `terminal` option */
interface BunTerminalHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface TerminalInstance {
  id: string;
  cwd: string;
  proc: ReturnType<typeof Bun.spawn>;
  terminal: BunTerminalHandle;
  browserSockets: Set<ServerWebSocket<SocketData>>;
  cols: number;
  rows: number;
  orphanTimer: ReturnType<typeof setTimeout> | null;
}

function resolveShell(): string {
  if (process.env.SHELL && existsSync(process.env.SHELL)) return process.env.SHELL;
  if (existsSync("/bin/bash")) return "/bin/bash";
  return "/bin/sh";
}

export class TerminalManager {
  private instance: TerminalInstance | null = null;

  /** Spawn a new global terminal in the given directory */
  spawn(cwd: string, cols = 80, rows = 24): string {
    // Kill existing instance if any
    if (this.instance) {
      this.kill();
    }

    const id = randomUUID();
    const shell = resolveShell();
    const sockets = new Set<ServerWebSocket<SocketData>>();

    const proc = Bun.spawn([shell, "-l"], {
      cwd,
      env: { ...process.env, TERM: "xterm-256color", CLAUDECODE: undefined },
      terminal: {
        cols,
        rows,
        data: (_terminal, data) => {
          // Broadcast raw PTY output as binary to all connected browsers
          for (const ws of sockets) {
            try {
              ws.sendBinary(data);
            } catch {
              // socket may have closed
            }
          }
        },
        exit: () => {
          // PTY stream closed — get exit code from proc
          const inst = this.instance;
          if (inst && inst.id === id) {
            const exitMsg = JSON.stringify({ type: "exit", exitCode: proc.exitCode ?? 0 });
            for (const ws of inst.browserSockets) {
              try {
                ws.send(exitMsg);
              } catch {
                // socket may have closed
              }
            }
          }
        },
      },
    });

    // Extract the terminal handle from the proc — Bun attaches it when spawned with `terminal` option
    const terminal = (proc as any).terminal as BunTerminalHandle;
    this.instance = { id, cwd, proc, terminal, browserSockets: sockets, cols, rows, orphanTimer: null };
    console.log(`[terminal] Spawned terminal ${id} in ${cwd} (${shell}, ${cols}x${rows})`);

    // Handle process exit
    proc.exited.then((exitCode) => {
      if (this.instance?.id === id) {
        console.log(`[terminal] Terminal ${id} exited with code ${exitCode}`);
      }
    });

    return id;
  }

  /** Handle a message from a browser WebSocket */
  handleBrowserMessage(_ws: ServerWebSocket<SocketData>, msg: string | Buffer): void {
    if (!this.instance) return;
    try {
      const str = typeof msg === "string" ? msg : msg.toString();
      const parsed = JSON.parse(str);
      if (parsed.type === "input" && typeof parsed.data === "string") {
        this.instance.terminal.write(parsed.data);
      } else if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
        this.resize(parsed.cols, parsed.rows);
      }
    } catch {
      // Malformed message, ignore
    }
  }

  /** Resize the PTY */
  resize(cols: number, rows: number): void {
    if (!this.instance) return;
    this.instance.cols = cols;
    this.instance.rows = rows;
    try {
      this.instance.terminal.resize(cols, rows);
    } catch {
      // resize not available or failed
    }
  }

  /** Kill the terminal process and clean up */
  kill(): void {
    if (!this.instance) return;
    const inst = this.instance;
    this.instance = null;

    if (inst.orphanTimer) {
      clearTimeout(inst.orphanTimer);
    }

    try {
      inst.proc.kill();
    } catch {
      // process may have already exited
    }

    // SIGKILL fallback if SIGTERM doesn't work within 2 seconds
    const pid = inst.proc.pid;
    setTimeout(() => {
      try {
        process.kill(pid, 0); // check if still alive
        inst.proc.kill(9); // SIGKILL
      } catch {
        // already dead, good
      }
    }, 2_000);

    console.log(`[terminal] Killed terminal ${inst.id}`);
  }

  /** Get current terminal info */
  getInfo(): { id: string; cwd: string } | null {
    if (!this.instance) return null;
    return { id: this.instance.id, cwd: this.instance.cwd };
  }

  /** Attach a browser WebSocket to the terminal */
  addBrowserSocket(ws: ServerWebSocket<SocketData>): void {
    if (!this.instance) return;

    // Cancel orphan kill timer if any
    if (this.instance.orphanTimer) {
      clearTimeout(this.instance.orphanTimer);
      this.instance.orphanTimer = null;
    }

    this.instance.browserSockets.add(ws);
  }

  /** Remove a browser WebSocket from the terminal */
  removeBrowserSocket(ws: ServerWebSocket<SocketData>): void {
    if (!this.instance) return;
    this.instance.browserSockets.delete(ws);

    // If no browsers remain, start a grace timer to kill the orphaned terminal
    if (this.instance.browserSockets.size === 0) {
      const id = this.instance.id;
      this.instance.orphanTimer = setTimeout(() => {
        if (this.instance?.id === id && this.instance.browserSockets.size === 0) {
          console.log(`[terminal] No browsers connected, killing orphaned terminal ${id}`);
          this.kill();
        }
      }, 5_000);
    }
  }
}
