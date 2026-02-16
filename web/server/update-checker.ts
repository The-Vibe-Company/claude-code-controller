import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Read current versions from package.json files ────────────────────────────

function readVersion(packageJsonPath: string): string {
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf-8")).version;
  } catch {
    return "0.0.0";
  }
}

const companionPackageJson = resolve(__dirname, "..", "package.json");
const wilcoPackageJson = resolve(homedir(), "wilco", "package.json");

const companionVersion = readVersion(companionPackageJson);
const wilcoVersion = readVersion(wilcoPackageJson);

// ── GitHub repos to check ────────────────────────────────────────────────────

const REPOS = {
  wilco: "rc-international/wilco",
  companion: "rc-int/companion",
} as const;

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 10_000; // 10 seconds after boot

// ── State ────────────────────────────────────────────────────────────────────

interface RepoState {
  current: string;
  latest: string | null;
}

interface UpdateState {
  wilco: RepoState;
  companion: RepoState;
  lastChecked: number;
  checking: boolean;
  updateInProgress: boolean;
}

const state: UpdateState = {
  wilco: { current: wilcoVersion, latest: null },
  companion: { current: companionVersion, latest: null },
  lastChecked: 0,
  checking: false,
  updateInProgress: false,
};

// ── Public API ───────────────────────────────────────────────────────────────

export function getUpdateState(): Readonly<UpdateState> {
  return {
    wilco: { ...state.wilco },
    companion: { ...state.companion },
    lastChecked: state.lastChecked,
    checking: state.checking,
    updateInProgress: state.updateInProgress,
  };
}

export function setUpdateInProgress(inProgress: boolean): void {
  state.updateInProgress = inProgress;
}

export function isUpdateAvailable(): boolean {
  const wilcoUpdate = state.wilco.latest !== null &&
    isNewerVersion(state.wilco.latest, state.wilco.current);
  const companionUpdate = state.companion.latest !== null &&
    isNewerVersion(state.companion.latest, state.companion.current);
  return wilcoUpdate || companionUpdate;
}

/** Simple semver comparison: returns true if a > b. Strips leading 'v'. */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// ── GitHub release fetching ──────────────────────────────────────────────────

async function fetchLatestRelease(repo: string): Promise<string | null> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { tag_name: string };
      return data.tag_name.replace(/^v/, "");
    }
  } catch (err) {
    console.warn(
      `[update-checker] Failed to check ${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return null;
}

export async function checkForUpdate(): Promise<void> {
  if (state.checking) return;
  state.checking = true;
  try {
    const [wilcoLatest, companionLatest] = await Promise.allSettled([
      fetchLatestRelease(REPOS.wilco),
      fetchLatestRelease(REPOS.companion),
    ]);

    if (wilcoLatest.status === "fulfilled" && wilcoLatest.value) {
      state.wilco.latest = wilcoLatest.value;
    }
    if (companionLatest.status === "fulfilled" && companionLatest.value) {
      state.companion.latest = companionLatest.value;
    }

    state.lastChecked = Date.now();

    if (isUpdateAvailable()) {
      const parts: string[] = [];
      if (state.wilco.latest && isNewerVersion(state.wilco.latest, state.wilco.current)) {
        parts.push(`wilco ${state.wilco.current} -> ${state.wilco.latest}`);
      }
      if (state.companion.latest && isNewerVersion(state.companion.latest, state.companion.current)) {
        parts.push(`companion ${state.companion.current} -> ${state.companion.latest}`);
      }
      console.log(`[update-checker] Updates available: ${parts.join(", ")}`);
    }
  } finally {
    state.checking = false;
  }
}

// ── Periodic checking ────────────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startPeriodicCheck(): void {
  setTimeout(() => {
    checkForUpdate();
  }, INITIAL_DELAY_MS);

  intervalId = setInterval(() => {
    checkForUpdate();
  }, CHECK_INTERVAL_MS);
}

export function stopPeriodicCheck(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
