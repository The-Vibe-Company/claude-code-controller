// Setup file for jsdom-based tests
// Polyfills that must be available before any module import

if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  // Node.js 22+ ships native localStorage that requires --localstorage-file.
  // Vitest may provide an invalid path, leaving a broken global that shadows
  // jsdom's working implementation. Polyfill when getItem is missing.
  if (
    typeof globalThis.localStorage === "undefined" ||
    typeof globalThis.localStorage.getItem !== "function"
  ) {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
      get length() { return store.size; },
      key: (index: number) => [...store.keys()][index] ?? null,
    };
    Object.defineProperty(globalThis, "localStorage", {
      value: storage,
      writable: true,
      configurable: true,
    });
  }

  // jsdom does not implement Web Workers. Provide a no-op stub so that
  // components using useSTT (which creates a Worker on mount) render without
  // throwing "Worker is not defined".
  if (typeof globalThis.Worker === "undefined") {
    class WorkerStub {
      onmessage: ((e: MessageEvent) => void) | null = null;
      postMessage() {}
      terminate() {}
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() { return false; }
    }
    Object.defineProperty(globalThis, "Worker", {
      value: WorkerStub,
      writable: true,
      configurable: true,
    });
  }
}
