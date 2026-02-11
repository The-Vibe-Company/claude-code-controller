import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";

let tempDir: string;
let auth: typeof import("./auth.js");

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => { dir = d; },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomedir.get() };
});

let savedEnv: string | undefined;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "auth-test-"));
  mockHomedir.set(tempDir);
  savedEnv = process.env.COMPANION_AUTH;
  delete process.env.COMPANION_AUTH;
  vi.resetModules();
  auth = await import("./auth.js");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (savedEnv !== undefined) process.env.COMPANION_AUTH = savedEnv;
  else delete process.env.COMPANION_AUTH;
});

// ===========================================================================
// Auth Config
// ===========================================================================
describe("Auth Config", () => {
  it("returns null when no auth.json exists", () => {
    expect(auth.loadAuthConfig()).toBeNull();
  });

  it("generates a 64-char hex token on first call", () => {
    const config = auth.getOrCreateAuthConfig();
    expect(config.token).toMatch(/^[a-f0-9]{64}$/);
    expect(config.createdAt).toBeGreaterThan(0);
    expect(config.sessionMaxAge).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("returns same token on subsequent calls", () => {
    const first = auth.getOrCreateAuthConfig();
    const second = auth.getOrCreateAuthConfig();
    expect(second.token).toBe(first.token);
  });

  it("persists config to filesystem", () => {
    const config = auth.getOrCreateAuthConfig();
    const raw = readFileSync(join(tempDir, ".companion", "auth.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.token).toBe(config.token);
  });

  it("isAuthEnabled returns false by default", () => {
    expect(auth.isAuthEnabled()).toBe(false);
  });

  it("isAuthEnabled returns true when COMPANION_AUTH=true", () => {
    process.env.COMPANION_AUTH = "true";
    expect(auth.isAuthEnabled()).toBe(true);
  });

  it("isAuthEnabled returns false for other values", () => {
    process.env.COMPANION_AUTH = "yes";
    expect(auth.isAuthEnabled()).toBe(false);
  });
});

// ===========================================================================
// HMAC Session
// ===========================================================================
describe("HMAC Session", () => {
  const token = "a".repeat(64);

  it("signs a session in uuid.hex format", () => {
    const cookie = auth.signSession("test-id", token);
    expect(cookie).toMatch(/^test-id\.[a-f0-9]{64}$/);
  });

  it("verifies a valid session cookie", () => {
    const cookie = auth.createSessionCookie(token);
    expect(auth.verifySessionCookie(cookie, token)).toBe(true);
  });

  it("rejects a tampered session id", () => {
    const cookie = auth.createSessionCookie(token);
    const [, sig] = cookie.split(".");
    expect(auth.verifySessionCookie(`tampered-id.${sig}`, token)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const cookie = auth.createSessionCookie(token);
    const [id] = cookie.split(".");
    expect(auth.verifySessionCookie(`${id}.${"b".repeat(64)}`, token)).toBe(false);
  });

  it("rejects cookie signed with different token", () => {
    const cookie = auth.createSessionCookie(token);
    expect(auth.verifySessionCookie(cookie, "b".repeat(64))).toBe(false);
  });

  it("rejects malformed cookie without dot", () => {
    expect(auth.verifySessionCookie("no-dot-here", token)).toBe(false);
  });
});

// ===========================================================================
// validateRequest
// ===========================================================================
describe("validateRequest", () => {
  it("returns valid=true when auth is disabled", () => {
    const req = new Request("http://localhost/test");
    expect(auth.validateRequest(req)).toEqual({ valid: true });
  });

  it("returns valid=true with valid session cookie", () => {
    process.env.COMPANION_AUTH = "true";
    const config = auth.getOrCreateAuthConfig();
    const cookie = auth.createSessionCookie(config.token);

    const req = new Request("http://localhost/test", {
      headers: { cookie: `companion_session=${cookie}` },
    });
    expect(auth.validateRequest(req)).toEqual({ valid: true });
  });

  it("returns valid=true + setCookie with correct ?token param", () => {
    process.env.COMPANION_AUTH = "true";
    const config = auth.getOrCreateAuthConfig();

    const req = new Request(`http://localhost/test?token=${config.token}`);
    const result = auth.validateRequest(req);
    expect(result.valid).toBe(true);
    expect(result.setCookie).toBeDefined();
  });

  it("returns valid=false without cookie or token", () => {
    process.env.COMPANION_AUTH = "true";
    auth.getOrCreateAuthConfig();

    const req = new Request("http://localhost/test");
    expect(auth.validateRequest(req)).toEqual({ valid: false });
  });

  it("returns valid=false with invalid cookie", () => {
    process.env.COMPANION_AUTH = "true";
    auth.getOrCreateAuthConfig();

    const req = new Request("http://localhost/test", {
      headers: { cookie: "companion_session=invalid.cookie" },
    });
    expect(auth.validateRequest(req)).toEqual({ valid: false });
  });

  it("returns valid=false with wrong token param", () => {
    process.env.COMPANION_AUTH = "true";
    auth.getOrCreateAuthConfig();

    const req = new Request("http://localhost/test?token=wrong-token");
    expect(auth.validateRequest(req)).toEqual({ valid: false });
  });
});

// ===========================================================================
// authMiddleware
// ===========================================================================
describe("authMiddleware", () => {
  function createApp() {
    const app = new Hono();
    app.use("/*", auth.authMiddleware());
    app.get("/test", (c) => c.json({ ok: true }));
    return app;
  }

  it("passes through when auth is disabled", async () => {
    const app = createApp();
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 401 without auth when enabled", async () => {
    process.env.COMPANION_AUTH = "true";
    auth.getOrCreateAuthConfig();

    const app = createApp();
    const res = await app.request("/test");
    expect(res.status).toBe(401);
  });

  it("passes with valid session cookie", async () => {
    process.env.COMPANION_AUTH = "true";
    const config = auth.getOrCreateAuthConfig();
    const cookie = auth.createSessionCookie(config.token);

    const app = createApp();
    const res = await app.request("/test", {
      headers: { cookie: `companion_session=${cookie}` },
    });
    expect(res.status).toBe(200);
  });

  it("redirects and sets cookie with valid ?token", async () => {
    process.env.COMPANION_AUTH = "true";
    const config = auth.getOrCreateAuthConfig();

    const app = createApp();
    const res = await app.request(`/test?token=${config.token}`, {
      headers: { host: "localhost:3456" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("companion_session=");
    expect(res.headers.get("location")).not.toContain("token=");
  });
});

// ===========================================================================
// authStatusHandler
// ===========================================================================
describe("authStatusHandler", () => {
  function createApp() {
    const app = new Hono();
    app.get("/auth/status", auth.authStatusHandler);
    return app;
  }

  it("returns enabled=false when auth is disabled", async () => {
    const app = createApp();
    const res = await app.request("/auth/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, authenticated: false });
  });

  it("returns enabled=true, authenticated=false without cookie", async () => {
    process.env.COMPANION_AUTH = "true";
    auth.getOrCreateAuthConfig();

    const app = createApp();
    const res = await app.request("/auth/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ enabled: true, authenticated: false });
  });

  it("returns authenticated=true with valid cookie", async () => {
    process.env.COMPANION_AUTH = "true";
    const config = auth.getOrCreateAuthConfig();
    const cookie = auth.createSessionCookie(config.token);

    const app = createApp();
    const res = await app.request("/auth/status", {
      headers: { cookie: `companion_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ enabled: true, authenticated: true });
  });
});
