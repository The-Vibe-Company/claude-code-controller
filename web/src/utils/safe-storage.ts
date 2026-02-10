/**
 * Safe localStorage wrapper with in-memory fallback
 *
 * Falls back to an in-memory Map when localStorage is unavailable
 * (private browsing, disabled cookies, SSR, etc.)
 */

let storage: Storage;

try {
  const testKey = "__safe_storage_test__";
  window.localStorage.setItem(testKey, "1");
  window.localStorage.removeItem(testKey);
  storage = window.localStorage;
} catch {
  // Fallback to in-memory storage
  const map = new Map<string, string>();
  storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

export const safeStorage = storage;
