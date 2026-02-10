import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface UsageLimits {
  five_hour: { utilization: number; resets_at: string | null } | null;
  seven_day: { utilization: number; resets_at: string | null } | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  } | null;
}

// In-memory cache (60s TTL)
const CACHE_DURATION_MS = 60 * 1000;
let cache: { data: UsageLimits; timestamp: number } | null = null;

export function getCredentials(): string | null {
  try {
    if (process.platform === "win32") {
      // Windows: read from credentials file
      const home =
        process.env.USERPROFILE || process.env.HOME || homedir() || "";
      const credPath = join(home, ".claude", ".credentials.json");
      if (!existsSync(credPath)) return null;
      const content = readFileSync(credPath, "utf-8");
      const parsed = JSON.parse(content);
      return parsed?.claudeAiOauth?.accessToken || null;
    }

    // macOS / Linux: read from system keychain
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();

    let decoded: string;
    if (raw.startsWith("{")) {
      decoded = raw;
    } else {
      decoded = Buffer.from(raw, "hex").toString("utf-8");
    }

    const match = decoded.match(
      /"claudeAiOauth":\{"accessToken":"(sk-ant-[^"]+)"/,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function fetchUsageLimits(
  token: string,
): Promise<UsageLimits | null> {
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "claude-code/2.0.31",
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    if (!response.ok) return null;

    const data = await response.json();
    return {
      five_hour: data.five_hour || null,
      seven_day: data.seven_day || null,
      extra_usage: data.extra_usage || null,
    };
  } catch {
    return null;
  }
}

export async function getUsageLimits(): Promise<UsageLimits> {
  const empty: UsageLimits = {
    five_hour: null,
    seven_day: null,
    extra_usage: null,
  };
  try {
    if (cache && Date.now() - cache.timestamp < CACHE_DURATION_MS) {
      return cache.data;
    }

    const token = getCredentials();
    if (!token) return empty;

    const limits = await fetchUsageLimits(token);
    if (!limits) return empty;

    cache = { data: limits, timestamp: Date.now() };
    return limits;
  } catch {
    return empty;
  }
}
