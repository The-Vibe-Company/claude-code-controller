import { execSync, type ExecSyncOptionsWithStringEncoding } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerConfig {
  /** Docker image to use (e.g. "companion-dev", "node:22-slim") */
  image: string;
  /** Container ports to expose (e.g. [3000, 8080]) */
  ports: number[];
  /** Extra volume mounts in "host:container[:opts]" format */
  volumes?: string[];
  /** Extra env vars to inject into the container */
  env?: Record<string, string>;
}

export interface PortMapping {
  containerPort: number;
  hostPort: number;
}

export interface ContainerInfo {
  containerId: string;
  name: string;
  image: string;
  portMappings: PortMapping[];
  hostCwd: string;
  containerCwd: string;
  state: "creating" | "running" | "stopped" | "removed";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXEC_OPTS: ExecSyncOptionsWithStringEncoding = {
  encoding: "utf-8",
  timeout: 30_000,
};
const QUICK_EXEC_TIMEOUT_MS = 8_000;
const STANDARD_EXEC_TIMEOUT_MS = 30_000;
const CONTAINER_BOOT_TIMEOUT_MS = 20_000;

function exec(cmd: string, opts?: ExecSyncOptionsWithStringEncoding): string {
  return execSync(cmd, { ...EXEC_OPTS, ...opts }).trim();
}

// ---------------------------------------------------------------------------
// ContainerManager
// ---------------------------------------------------------------------------

export class ContainerManager {
  private containers = new Map<string, ContainerInfo>();

  /** Check whether Docker daemon is reachable. */
  checkDocker(): boolean {
    try {
      exec("docker info --format '{{.ServerVersion}}'", {
        encoding: "utf-8",
        timeout: QUICK_EXEC_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Return Docker version string, or null if unavailable. */
  getDockerVersion(): string | null {
    try {
      return exec("docker version --format '{{.Server.Version}}'", {
        encoding: "utf-8",
        timeout: QUICK_EXEC_TIMEOUT_MS,
      });
    } catch {
      return null;
    }
  }

  /** List images available locally. Returns image:tag strings. */
  listImages(): string[] {
    try {
      const raw = exec("docker images --format '{{.Repository}}:{{.Tag}}'", {
        encoding: "utf-8",
        timeout: QUICK_EXEC_TIMEOUT_MS,
      });
      if (!raw) return [];
      return raw
        .split("\n")
        .filter((l) => l && !l.startsWith("<none>"))
        .sort();
    } catch {
      return [];
    }
  }

  /** Check if a specific image exists locally. */
  imageExists(image: string): boolean {
    try {
      exec(`docker image inspect ${shellEscape(image)}`, {
        encoding: "utf-8",
        timeout: QUICK_EXEC_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create and start a container for a session.
   *
   * - Mounts `~/.claude` read-only at `/companion-host-claude` (auth seed)
   * - Uses a writable tmpfs at `/root/.claude` for runtime state
   * - Mounts `hostCwd` at `/workspace`
   * - Publishes requested ports with auto-assigned host ports (`-p 0:PORT`)
   */
  createContainer(
    sessionId: string,
    hostCwd: string,
    config: ContainerConfig,
  ): ContainerInfo {
    const name = `companion-${sessionId.slice(0, 8)}`;
    const homedir = process.env.HOME || process.env.USERPROFILE || "/root";

    // Validate port numbers
    for (const port of config.ports) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port number: ${port} (must be 1-65535)`);
      }
    }

    // Build docker create args
    const args: string[] = [
      "docker", "create",
      "--name", name,
      // Ensure host.docker.internal resolves (automatic on Mac/Win Docker
      // Desktop, but required explicitly on Linux)
      "--add-host=host.docker.internal:host-gateway",
      // Seed auth/config from host home, but keep runtime writes inside container.
      "-v", `${homedir}/.claude:/companion-host-claude:ro`,
      "--tmpfs", "/root/.claude",
      "-v", `${hostCwd}:/workspace`,
      "-w", "/workspace",
    ];

    // Port mappings: -p 0:{containerPort}
    for (const port of config.ports) {
      args.push("-p", `0:${port}`);
    }

    // Extra volumes
    if (config.volumes) {
      for (const vol of config.volumes) {
        args.push("-v", vol);
      }
    }

    // Environment variables
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        args.push("-e", `${k}=${v}`);
      }
    }

    // Image + default command (keep container alive)
    args.push(config.image, "sleep", "infinity");

    const info: ContainerInfo = {
      containerId: "",
      name,
      image: config.image,
      portMappings: [],
      hostCwd,
      containerCwd: "/workspace",
      state: "creating",
    };

    try {
      // Create
      const containerId = exec(args.map(shellEscape).join(" "), {
        encoding: "utf-8",
        timeout: CONTAINER_BOOT_TIMEOUT_MS,
      });
      info.containerId = containerId;

      // Start
      exec(`docker start ${shellEscape(containerId)}`, {
        encoding: "utf-8",
        timeout: CONTAINER_BOOT_TIMEOUT_MS,
      });
      info.state = "running";

      // Seed writable Claude home from host read-only mount.
      // Only copy essential files (auth + settings + skills) to avoid
      // copying large directories (projects/, sessions.db, statsig/) that
      // can make container startup very slow.
      try {
        this.execInContainer(containerId, [
          "sh",
          "-lc",
          [
            "mkdir -p /root/.claude",
            // Auth files
            "for f in .credentials.json auth.json .auth.json credentials.json; do " +
              "[ -f /companion-host-claude/$f ] && cp /companion-host-claude/$f /root/.claude/$f 2>/dev/null; done",
            // Settings
            "for f in settings.json settings.local.json; do " +
              "[ -f /companion-host-claude/$f ] && cp /companion-host-claude/$f /root/.claude/$f 2>/dev/null; done",
            // Skills directory (shallow copy)
            "[ -d /companion-host-claude/skills ] && cp -r /companion-host-claude/skills /root/.claude/skills 2>/dev/null",
            "true",
          ].join("; "),
        ]);
      } catch {
        // no-op
      }

      // Resolve actual port mappings
      info.portMappings = this.resolvePortMappings(containerId, config.ports);

      this.containers.set(sessionId, info);
      console.log(
        `[container-manager] Created container ${name} (${containerId.slice(0, 12)}) ` +
        `ports: ${info.portMappings.map((p) => `${p.containerPort}->${p.hostPort}`).join(", ")}`,
      );

      return info;
    } catch (e) {
      // Cleanup partial creation
      try { exec(`docker rm -f ${shellEscape(name)}`); } catch { /* ignore */ }
      info.state = "removed";
      throw new Error(
        `Failed to create container: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Parse `docker port` output to get host port mappings. */
  private resolvePortMappings(containerId: string, ports: number[]): PortMapping[] {
    const mappings: PortMapping[] = [];
    for (const containerPort of ports) {
      try {
        const raw = exec(
          `docker port ${shellEscape(containerId)} ${containerPort}`,
        );
        // Output like "0.0.0.0:49152" or "[::]:49152"
        const match = raw.match(/:(\d+)$/m);
        if (match) {
          mappings.push({
            containerPort,
            hostPort: parseInt(match[1], 10),
          });
        }
      } catch {
        console.warn(
          `[container-manager] Could not resolve port ${containerPort} for ${containerId.slice(0, 12)}`,
        );
      }
    }
    return mappings;
  }

  /**
   * Execute a command inside a running container.
   * Returns the stdout output. Throws on failure.
   */
  execInContainer(containerId: string, cmd: string[], timeout = STANDARD_EXEC_TIMEOUT_MS): string {
    const dockerCmd = [
      "docker", "exec",
      shellEscape(containerId),
      ...cmd.map(shellEscape),
    ].join(" ");
    return exec(dockerCmd, { encoding: "utf-8", timeout });
  }

  /**
   * Execute a command inside a running container asynchronously.
   * Uses Bun.spawn for longer-running operations (like init scripts).
   * Returns exit code and combined stdout+stderr output.
   */
  async execInContainerAsync(
    containerId: string,
    cmd: string[],
    opts?: { timeout?: number; onOutput?: (line: string) => void },
  ): Promise<{ exitCode: number; output: string }> {
    const timeout = opts?.timeout ?? 120_000;
    const dockerCmd = [
      "docker", "exec",
      containerId,
      ...cmd,
    ];

    const proc = Bun.spawn(dockerCmd, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const lines: string[] = [];
    const decoder = new TextDecoder();

    // Read stdout
    const stdoutReader = proc.stdout.getReader();
    let stdoutBuffer = "";
    const readStdout = (async () => {
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          stdoutBuffer += decoder.decode(value, { stream: true });
          const parts = stdoutBuffer.split("\n");
          stdoutBuffer = parts.pop() || "";
          for (const line of parts) {
            lines.push(line);
            opts?.onOutput?.(line);
          }
        }
        if (stdoutBuffer.trim()) {
          lines.push(stdoutBuffer);
          opts?.onOutput?.(stdoutBuffer);
        }
      } finally {
        stdoutReader.releaseLock();
      }
    })();

    // Read stderr
    const stderrPromise = new Response(proc.stderr).text();

    // Apply timeout
    const exitPromise = proc.exited;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error(`Command timed out after ${timeout}ms`));
      }, timeout),
    );

    try {
      const exitCode = await Promise.race([exitPromise, timeoutPromise]);
      await readStdout;
      const stderrText = await stderrPromise;
      if (stderrText.trim()) {
        for (const line of stderrText.split("\n")) {
          if (line.trim()) {
            lines.push(line);
            opts?.onOutput?.(line);
          }
        }
      }
      return { exitCode, output: lines.join("\n") };
    } catch (e) {
      await readStdout.catch(() => {});
      throw e;
    }
  }

  /**
   * Re-track a container under a new key (e.g. when the real sessionId
   * is assigned after container creation).
   */
  retrack(containerId: string, newSessionId: string): void {
    for (const [oldKey, info] of this.containers) {
      if (info.containerId === containerId) {
        this.containers.delete(oldKey);
        this.containers.set(newSessionId, info);
        return;
      }
    }
  }

  /** Stop and remove a container. */
  removeContainer(sessionId: string): void {
    const info = this.containers.get(sessionId);
    if (!info) return;

    try {
      exec(`docker rm -f ${shellEscape(info.containerId)}`);
      info.state = "removed";
      console.log(
        `[container-manager] Removed container ${info.name} (${info.containerId.slice(0, 12)})`,
      );
    } catch (e) {
      console.warn(
        `[container-manager] Failed to remove container ${info.name}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
    this.containers.delete(sessionId);
  }

  /** Get container info for a session. */
  getContainer(sessionId: string): ContainerInfo | undefined {
    return this.containers.get(sessionId);
  }

  /** List all tracked containers. */
  listContainers(): ContainerInfo[] {
    return Array.from(this.containers.values());
  }

  /** Attempt to start a stopped container. Throws on failure. */
  startContainer(containerId: string): void {
    exec(`docker start ${shellEscape(containerId)}`, {
      encoding: "utf-8",
      timeout: CONTAINER_BOOT_TIMEOUT_MS,
    });
  }

  /**
   * Check whether a Docker container exists and its running state.
   * Returns "running", "stopped", or "missing".
   */
  isContainerAlive(containerId: string): "running" | "stopped" | "missing" {
    try {
      const state = exec(
        `docker inspect --format '{{.State.Running}}' ${shellEscape(containerId)}`,
        { encoding: "utf-8", timeout: QUICK_EXEC_TIMEOUT_MS },
      );
      return state === "true" ? "running" : "stopped";
    } catch {
      return "missing";
    }
  }

  /**
   * Check if a binary is available inside a running container.
   * Uses `bash -lc` so PATH includes nvm/bun/deno/etc.
   */
  hasBinaryInContainer(containerId: string, binary: string): boolean {
    try {
      exec(
        `docker exec ${shellEscape(containerId)} bash -lc 'which ${shellEscape(binary)}'`,
        { encoding: "utf-8", timeout: QUICK_EXEC_TIMEOUT_MS },
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Re-register a container that was persisted across a server restart.
   * Verifies the container still exists in Docker before tracking it.
   */
  restoreContainer(sessionId: string, info: ContainerInfo): boolean {
    try {
      const state = exec(
        `docker inspect --format '{{.State.Running}}' ${shellEscape(info.containerId)}`,
      );
      if (state === "true") {
        info.state = "running";
      } else {
        info.state = "stopped";
      }
      this.containers.set(sessionId, info);
      console.log(
        `[container-manager] Restored container ${info.name} (${info.containerId.slice(0, 12)}) state=${info.state}`,
      );
      return true;
    } catch {
      // Container no longer exists in Docker
      console.warn(
        `[container-manager] Container ${info.name} (${info.containerId.slice(0, 12)}) no longer exists, skipping restore`,
      );
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence — survive server restarts
  // ---------------------------------------------------------------------------

  /** Persist all tracked container info to disk. */
  persistState(filePath: string): void {
    try {
      const entries: { sessionId: string; info: ContainerInfo }[] = [];
      for (const [sessionId, info] of this.containers) {
        if (info.state !== "removed") {
          entries.push({ sessionId, info });
        }
      }
      writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
    } catch (e) {
      console.warn(
        "[container-manager] Failed to persist state:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /** Restore container tracking from disk, verifying each container still exists. */
  restoreState(filePath: string): number {
    if (!existsSync(filePath)) return 0;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const entries: { sessionId: string; info: ContainerInfo }[] = JSON.parse(raw);
      let restored = 0;
      for (const { sessionId, info } of entries) {
        if (this.restoreContainer(sessionId, info)) {
          restored++;
        }
      }
      if (restored > 0) {
        console.log(`[container-manager] Restored ${restored} container(s) from disk`);
      }
      return restored;
    } catch (e) {
      console.warn(
        "[container-manager] Failed to restore state:",
        e instanceof Error ? e.message : String(e),
      );
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Image building
  // ---------------------------------------------------------------------------

  /**
   * Build the companion-dev Docker image from the Dockerfile.dev.
   * Returns the build output log. Throws on failure.
   */
  buildImage(dockerfilePath: string, tag: string = "companion-dev:latest"): string {
    const contextDir = dockerfilePath.replace(/\/[^/]+$/, "") || ".";
    try {
      const output = exec(
        `docker build -t ${shellEscape(tag)} -f ${shellEscape(dockerfilePath)} ${shellEscape(contextDir)}`,
        { encoding: "utf-8", timeout: 300_000 }, // 5 min for image builds
      );
      console.log(`[container-manager] Built image ${tag}`);
      return output;
    } catch (e) {
      throw new Error(
        `Failed to build image ${tag}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Build a Docker image from inline Dockerfile content using Bun.spawn for streaming output.
   * Writes the Dockerfile to a temp directory and runs docker build.
   */
  async buildImageStreaming(
    dockerfileContent: string,
    tag: string,
    onProgress?: (line: string) => void,
  ): Promise<{ success: boolean; log: string }> {
    // Write Dockerfile to temp dir
    const buildDir = join(tmpdir(), `companion-build-${Date.now()}`);
    mkdirSync(buildDir, { recursive: true });
    const dockerfilePath = join(buildDir, "Dockerfile");
    writeFileSync(dockerfilePath, dockerfileContent, "utf-8");

    const args = [
      "docker", "build",
      "-t", tag,
      "-f", dockerfilePath,
      buildDir,
    ];

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const lines: string[] = [];

    // Read stdout line by line
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() || "";
        for (const line of parts) {
          if (line.trim()) {
            lines.push(line);
            onProgress?.(line);
          }
        }
      }
      // Flush remaining buffer
      if (buffer.trim()) {
        lines.push(buffer);
        onProgress?.(buffer);
      }
    } finally {
      reader.releaseLock();
    }

    // Also capture stderr
    const stderrText = await new Response(proc.stderr).text();
    if (stderrText.trim()) {
      for (const line of stderrText.split("\n")) {
        if (line.trim()) {
          lines.push(line);
          onProgress?.(line);
        }
      }
    }

    const exitCode = await proc.exited;
    const log = lines.join("\n");

    if (exitCode === 0) {
      console.log(`[container-manager] Built image ${tag} (streaming)`);
      return { success: true, log };
    }

    return { success: false, log };
  }

  /** Clean up all tracked containers (e.g. on server shutdown). */
  cleanupAll(): void {
    for (const [sessionId] of this.containers) {
      this.removeContainer(sessionId);
    }
  }
}

// ---------------------------------------------------------------------------
// Shell escape helper
// ---------------------------------------------------------------------------

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9._\-/:=@]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Singleton
export const containerManager = new ContainerManager();
