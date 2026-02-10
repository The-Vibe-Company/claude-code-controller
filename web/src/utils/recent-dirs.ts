import { safeStorage } from "./safe-storage";

const RECENT_DIRS_KEY = "cc-recent-dirs";

export function getRecentDirs(): string[] {
  try {
    return JSON.parse(safeStorage.getItem(RECENT_DIRS_KEY) || "[]");
  } catch {
    return [];
  }
}

export function addRecentDir(dir: string) {
  const dirs = getRecentDirs().filter((d) => d !== dir);
  dirs.unshift(dir);
  safeStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(dirs.slice(0, 5)));
}
