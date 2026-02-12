import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { loadConfig } from "./tunnel-config.js";

// ─── JWKS Cache ─────────────────────────────────────────────────────────────

const jwksCache = new Map<string, { jwks: ReturnType<typeof createRemoteJWKSet>; createdAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getJWKS(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(teamDomain);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return cached.jwks;
  }

  const certsUrl = new URL(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`);
  const jwks = createRemoteJWKSet(certsUrl);
  jwksCache.set(teamDomain, { jwks, createdAt: Date.now() });
  return jwks;
}

// ─── JWT Verification ───────────────────────────────────────────────────────

export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  audienceTag?: string,
): Promise<{ email?: string }> {
  const jwks = getJWKS(teamDomain);

  const verifyOptions: Parameters<typeof jwtVerify>[2] = {
    issuer: `https://${teamDomain}.cloudflareaccess.com`,
  };
  if (audienceTag) {
    verifyOptions.audience = audienceTag;
  }

  const { payload } = await jwtVerify(token, jwks, verifyOptions);
  return { email: payload.email as string | undefined };
}

// ─── Hono Middleware ────────────────────────────────────────────────────────

export function cfAccessMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const config = loadConfig();

    // If no tunnel configured or no team domain set, skip verification
    if (!config?.teamDomain) {
      return next();
    }

    const jwt = c.req.header("Cf-Access-Jwt-Assertion");
    if (!jwt) {
      // No JWT header means this is a direct localhost request — allow it.
      // Cloudflare Access always injects this header for tunneled requests.
      return next();
    }

    try {
      const { email } = await verifyAccessJwt(jwt, config.teamDomain, config.audienceTag);
      if (email) {
        c.set("cfAccessEmail", email);
      }
      return next();
    } catch (err) {
      console.warn("[cf-access] JWT verification failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "Access denied: invalid token" }, 403);
    }
  };
}
