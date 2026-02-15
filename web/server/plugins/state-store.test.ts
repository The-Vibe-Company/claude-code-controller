import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach } from "vitest";
import { PluginStateStore } from "./state-store.js";

const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0, testDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PluginStateStore", () => {
  it("does not leak enabled state between fresh store instances", () => {
    // This validates we always allocate a fresh empty state object per store.
    const dirA = mkdtempSync(join(tmpdir(), "plugin-state-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "plugin-state-b-"));
    testDirs.push(dirA, dirB);

    const storeA = new PluginStateStore(join(dirA, "plugins.json"));
    storeA.update((draft) => {
      draft.enabled["permission-automation"] = true;
    });

    const storeB = new PluginStateStore(join(dirB, "plugins.json"));
    const stateB = storeB.getState();

    expect(stateB.enabled).toEqual({});
  });

  it("does not leak config state between fresh store instances", () => {
    // This validates config maps are isolated when the state file does not exist.
    const dirA = mkdtempSync(join(tmpdir(), "plugin-state-c-"));
    const dirB = mkdtempSync(join(tmpdir(), "plugin-state-d-"));
    testDirs.push(dirA, dirB);

    const storeA = new PluginStateStore(join(dirA, "plugins.json"));
    storeA.update((draft) => {
      draft.config.notifications = { onResultError: true };
    });

    const storeB = new PluginStateStore(join(dirB, "plugins.json"));
    const stateB = storeB.getState();

    expect(stateB.config).toEqual({});
  });
});
