/**
 * Cross-platform utilities for process management and path handling.
 * Abstracts OS differences so the rest of the codebase can stay platform-agnostic.
 */

import { execFileSync } from "node:child_process";

export const isWindows = process.platform === "win32";

/** PATH environment variable delimiter: `;` on Windows, `:` elsewhere. */
export const PATH_DELIMITER = isWindows ? ";" : ":";

/**
 * Gracefully terminate a Bun subprocess.
 * On Windows, proc.kill() without a signal sends TerminateProcess.
 * On Unix, sends SIGTERM for graceful shutdown.
 */
export function gracefulKill(proc: { kill(signal?: number | string): void }): void {
  if (isWindows) {
    proc.kill();
  } else {
    proc.kill("SIGTERM");
  }
}

/**
 * Force-kill a Bun subprocess.
 * Note: On Windows, both gracefulKill and forceKill call proc.kill() which
 * sends TerminateProcess — there is no graceful vs forced distinction.
 */
export function forceKill(proc: { kill(signal?: number | string): void }): void {
  if (isWindows) {
    proc.kill();
  } else {
    proc.kill("SIGKILL");
  }
}

/**
 * Kill a process by PID. Uses `taskkill` on Windows, `process.kill` on Unix.
 */
export function killByPid(pid: number): void {
  try {
    if (isWindows) {
      execFileSync("taskkill", ["/PID", String(pid), "/F"], { timeout: 5000 });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Process may already be dead
  }
}

/**
 * Resolve a binary name using the system's binary locator.
 * Uses `where` on Windows, `which` on Unix.
 * Returns the first match or falls back to the original name.
 */
export function resolveWhich(binary: string): string {
  try {
    const result = execFileSync(
      isWindows ? "where" : "which",
      [binary],
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    return result.split(/\r?\n/)[0].trim();
  } catch {
    return binary;
  }
}

/**
 * Check whether a binary exists on PATH.
 */
export function binaryExists(name: string): boolean {
  try {
    execFileSync(
      isWindows ? "where" : "which",
      [name],
      { encoding: "utf-8", timeout: 3000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path is absolute (handles both Unix and Windows formats).
 */
export function isAbsolutePath(p: string): boolean {
  if (p.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return false;
}

/**
 * Normalize path separators: replace backslashes with forward slashes.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}
