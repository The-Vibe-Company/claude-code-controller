import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read current version from package.json
const packageJsonPath = resolve(__dirname, "..", "package.json");
const currentVersion: string = JSON.parse(
  readFileSync(packageJsonPath, "utf-8"),
).version;

const NPM_REGISTRY_URL = "https://registry.npmjs.org/the-companion/latest";
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 10_000; // 10 seconds after boot

interface UpdateState {
  currentVersion: string;
  latestVersion: string | null;
  lastChecked: number;
  isServiceMode: boolean;
  checking: boolean;
  updateInProgress: boolean;
}

const state: UpdateState = {
  currentVersion,
  latestVersion: null,
  lastChecked: 0,
  isServiceMode: false,
  checking: false,
  updateInProgress: false,
};

export function getUpdateState(): Readonly<UpdateState> {
  return { ...state };
}

export function getCurrentVersion(): string {
  return currentVersion;
}

export async function checkForUpdate(): Promise<void> {
  if (state.checking) return;
  state.checking = true;
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { version: string };
      state.latestVersion = data.version;
      state.lastChecked = Date.now();
      if (isUpdateAvailable()) {
        console.log(
          `[update-checker] Update available: ${currentVersion} -> ${state.latestVersion}`,
        );
      }
    }
  } catch (err) {
    console.warn(
      "[update-checker] Failed to check for updates:",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    state.checking = false;
  }
}

export function setServiceMode(isService: boolean): void {
  state.isServiceMode = isService;
}

export function setUpdateInProgress(inProgress: boolean): void {
  state.updateInProgress = inProgress;
}

export function isUpdateAvailable(): boolean {
  if (!state.latestVersion) return false;
  return isNewerVersion(state.latestVersion, currentVersion);
}

/** Simple semver comparison: returns true if a > b */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startPeriodicCheck(): void {
  // Initial check after a short delay
  setTimeout(() => {
    checkForUpdate();
  }, INITIAL_DELAY_MS);

  // Periodic checks
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
