import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import type { MiddlewareHandler, Context } from "hono";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AuthConfig {
  token: string;
  createdAt: number;
  sessionMaxAge: number; // ms, default 7 days
}

// ─── Constants ──────────────────────────────────────────────────────────────

const COMPANION_DIR = join(homedir(), ".companion");
const AUTH_FILE = join(COMPANION_DIR, "auth.json");
const SESSION_COOKIE = "companion_session";
const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Auth Config Management ─────────────────────────────────────────────────

export function isAuthEnabled(): boolean {
  return process.env.COMPANION_AUTH === "true";
}

export function loadAuthConfig(): AuthConfig | null {
  try {
    const raw = readFileSync(AUTH_FILE, "utf-8");
    return JSON.parse(raw) as AuthConfig;
  } catch {
    return null;
  }
}

export function saveAuthConfig(config: AuthConfig): void {
  mkdirSync(COMPANION_DIR, { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(config, null, 2), "utf-8");
  try {
    chmodSync(AUTH_FILE, 0o600);
  } catch {
    // Windows may not support chmod — best-effort
  }
}

export function getOrCreateAuthConfig(): AuthConfig {
  const existing = loadAuthConfig();
  if (existing) return existing;

  const config: AuthConfig = {
    token: randomBytes(32).toString("hex"),
    createdAt: Date.now(),
    sessionMaxAge: DEFAULT_MAX_AGE,
  };
  saveAuthConfig(config);
  return config;
}

// ─── HMAC Session Signing ───────────────────────────────────────────────────

export function signSession(sessionId: string, token: string): string {
  const hmac = createHmac("sha256", token).update(sessionId).digest("hex");
  return `${sessionId}.${hmac}`;
}

export function createSessionCookie(token: string): string {
  const sessionId = randomUUID();
  return signSession(sessionId, token);
}

export function verifySessionCookie(cookieValue: string, token: string): boolean {
  const dotIndex = cookieValue.indexOf(".");
  if (dotIndex === -1) return false;

  const sessionId = cookieValue.slice(0, dotIndex);
  const signature = cookieValue.slice(dotIndex + 1);

  const expected = createHmac("sha256", token).update(sessionId).digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false; // Different lengths or invalid hex
  }
}

// ─── Request Validation (for Bun.serve fetch, pre-Hono) ────────────────────

export function validateRequest(req: Request): { valid: boolean; setCookie?: string } {
  if (!isAuthEnabled()) return { valid: true };

  const config = loadAuthConfig();
  if (!config) return { valid: false };

  // Check session cookie
  const cookieHeader = req.headers.get("cookie") || "";
  const match = cookieHeader.match(/companion_session=([^;]+)/);
  if (match && verifySessionCookie(match[1], config.token)) {
    return { valid: true };
  }

  // Check ?token= query param
  const url = new URL(req.url);
  const tokenParam = url.searchParams.get("token");
  if (tokenParam === config.token) {
    return { valid: true, setCookie: createSessionCookie(config.token) };
  }

  return { valid: false };
}

// ─── Hono Middleware ────────────────────────────────────────────────────────

export function authMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!isAuthEnabled()) return next();

    const config = loadAuthConfig();
    if (!config) return c.json({ error: "Auth misconfigured" }, 500);

    // Check session cookie
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie && verifySessionCookie(cookie, config.token)) {
      return next();
    }

    // Check ?token= query param — set cookie and redirect without token
    const tokenParam = c.req.query("token");
    if (tokenParam === config.token) {
      const cookieValue = createSessionCookie(config.token);
      setCookie(c, SESSION_COOKIE, cookieValue, {
        httpOnly: true,
        sameSite: "Lax",
        maxAge: Math.floor(config.sessionMaxAge / 1000),
        path: "/",
      });

      // Redirect to same URL without the token param
      const url = new URL(c.req.url);
      url.searchParams.delete("token");
      return c.redirect(url.toString(), 302);
    }

    return c.json({ error: "Unauthorized" }, 401);
  };
}

// ─── Route Handlers ─────────────────────────────────────────────────────────

export function authStatusHandler(c: Context): Response {
  const enabled = isAuthEnabled();
  if (!enabled) {
    return c.json({ enabled: false, authenticated: false });
  }

  const config = loadAuthConfig();
  if (!config) return c.json({ enabled: true, authenticated: false });

  const cookie = getCookie(c, SESSION_COOKIE);
  const authenticated = !!cookie && verifySessionCookie(cookie, config.token);
  return c.json({ enabled, authenticated });
}
