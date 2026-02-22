import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { networkInterfaces } from "node:os";

const AUTH_FILE = join(homedir(), ".companion", "auth.json");
const TOKEN_BYTES = 32; // 64 hex characters

interface AuthData {
  token: string;
  createdAt: number;
}

let cachedToken: string | null = null;

/**
 * Get the auth token. Priority:
 * 1. COMPANION_AUTH_TOKEN env var
 * 2. Persisted token from ~/.companion/auth.json
 * 3. Auto-generate and persist a new token
 */
export function getToken(): string {
  // Env var override (always takes priority)
  const envToken = process.env.COMPANION_AUTH_TOKEN;
  if (envToken && envToken.trim()) {
    cachedToken = envToken.trim();
    return cachedToken;
  }

  // Return cached token if available
  if (cachedToken) return cachedToken;

  // Try reading from file
  try {
    if (existsSync(AUTH_FILE)) {
      const raw = readFileSync(AUTH_FILE, "utf-8");
      const data = JSON.parse(raw) as Partial<AuthData>;
      if (typeof data.token === "string" && data.token.length >= 32) {
        cachedToken = data.token;
        return cachedToken;
      }
    }
  } catch {
    // File corrupt or unreadable — generate new
  }

  // Generate new token
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const data: AuthData = { token, createdAt: Date.now() };
  try {
    mkdirSync(dirname(AUTH_FILE), { recursive: true });
    writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("[auth] Failed to persist auth token:", err);
  }
  cachedToken = token;
  return token;
}

/**
 * Verify a candidate token using constant-time comparison.
 */
export function verifyToken(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const expected = getToken();
  const candidateBuf = Buffer.from(candidate);
  const expectedBuf = Buffer.from(expected);
  if (candidateBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(candidateBuf, expectedBuf);
}

/**
 * Get the primary LAN IP address for QR code URL generation.
 * Falls back to "localhost" if no LAN IP is found.
 */
export function getLanAddress(): string {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "localhost";
}

/** Reset cached state — for testing only */
export function _resetForTest(): void {
  cachedToken = null;
}
