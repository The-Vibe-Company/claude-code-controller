import { execSync, type ExecSyncOptionsWithStringEncoding } from "node:child_process";

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
      exec("docker info --format '{{.ServerVersion}}'");
      return true;
    } catch {
      return false;
    }
  }

  /** Return Docker version string, or null if unavailable. */
  getDockerVersion(): string | null {
    try {
      return exec("docker version --format '{{.Server.Version}}'");
    } catch {
      return null;
    }
  }

  /** List images available locally. Returns image:tag strings. */
  listImages(): string[] {
    try {
      const raw = exec("docker images --format '{{.Repository}}:{{.Tag}}'");
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
      exec(`docker image inspect ${shellEscape(image)}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create and start a container for a session.
   *
   * - Mounts `~/.claude` read-only (auth)
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
      "-v", `${homedir}/.claude:/root/.claude:ro`,
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
      const containerId = exec(args.map(shellEscape).join(" "));
      info.containerId = containerId;

      // Start
      exec(`docker start ${shellEscape(containerId)}`);
      info.state = "running";

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
