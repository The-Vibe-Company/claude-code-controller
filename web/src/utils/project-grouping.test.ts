import { describe, it, expect } from "vitest";
import { groupSessionsByProject, deriveProjectName } from "./project-grouping.js";
import type { SidebarSession } from "../types.js";

function makeSession(overrides: Partial<SidebarSession> = {}): SidebarSession {
  return {
    id: "test-" + Math.random().toString(36).slice(2, 8),
    isWorktree: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: false,
    status: null,
    ...overrides,
  };
}

describe("deriveProjectName", () => {
  it("extracts last path segment", () => {
    expect(deriveProjectName("/Users/foo/projects/my-app")).toBe("my-app");
  });

  it("handles trailing slash", () => {
    expect(deriveProjectName("/Users/foo/projects/my-app/")).toBe("my-app");
  });

  it("returns full key if no segments", () => {
    expect(deriveProjectName("")).toBe("");
  });
});

describe("groupSessionsByProject", () => {
  it("groups sessions by projectKey", () => {
    const sessions = [
      makeSession({ id: "s1", projectKey: "/repo/a", cwd: "/repo/a" }),
      makeSession({ id: "s2", projectKey: "/repo/a", cwd: "/repo/a/sub" }),
      makeSession({ id: "s3", projectKey: "/repo/b", cwd: "/repo/b" }),
    ];
    const result = groupSessionsByProject(sessions, new Map(), new Map());
    expect(result).toHaveLength(2);
    expect(result.find((p) => p.key === "/repo/a")?.sessions).toHaveLength(2);
    expect(result.find((p) => p.key === "/repo/b")?.sessions).toHaveLength(1);
  });

  it("falls back to cwd when projectKey is missing", () => {
    const sessions = [
      makeSession({ id: "s1", cwd: "/non-git/dir" }),
    ];
    const result = groupSessionsByProject(sessions, new Map(), new Map());
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("/non-git/dir");
  });

  it("uses custom project names", () => {
    const sessions = [
      makeSession({ id: "s1", projectKey: "/repo/a", cwd: "/repo/a" }),
    ];
    const names = new Map([["/repo/a", "My Project"]]);
    const result = groupSessionsByProject(sessions, names, new Map());
    expect(result[0].name).toBe("My Project");
  });

  it("derives name from path when no custom name", () => {
    const sessions = [
      makeSession({ id: "s1", projectKey: "/Users/foo/companion", cwd: "/Users/foo/companion" }),
    ];
    const result = groupSessionsByProject(sessions, new Map(), new Map());
    expect(result[0].name).toBe("companion");
  });

  it("aggregates costs from sessionCosts map", () => {
    const sessions = [
      makeSession({ id: "s1", projectKey: "/repo/a" }),
      makeSession({ id: "s2", projectKey: "/repo/a" }),
    ];
    const costs = new Map([["s1", 0.50], ["s2", 0.25]]);
    const result = groupSessionsByProject(sessions, new Map(), costs);
    expect(result[0].totalCost).toBeCloseTo(0.75);
  });

  it("counts active (non-archived) sessions", () => {
    const sessions = [
      makeSession({ id: "s1", projectKey: "/repo/a", archived: false }),
      makeSession({ id: "s2", projectKey: "/repo/a", archived: true }),
      makeSession({ id: "s3", projectKey: "/repo/a", archived: false }),
    ];
    const result = groupSessionsByProject(sessions, new Map(), new Map());
    expect(result[0].activeSessions).toBe(2);
  });

  it("sorts running projects first", () => {
    const sessions = [
      makeSession({ id: "s1", projectKey: "/repo/idle", status: null, createdAt: 200 }),
      makeSession({ id: "s2", projectKey: "/repo/running", status: "running", createdAt: 100 }),
    ];
    const result = groupSessionsByProject(sessions, new Map(), new Map());
    expect(result[0].key).toBe("/repo/running");
    expect(result[1].key).toBe("/repo/idle");
  });

  it("sorts by most recent session within same running state", () => {
    const sessions = [
      makeSession({ id: "s1", projectKey: "/repo/old", createdAt: 100 }),
      makeSession({ id: "s2", projectKey: "/repo/new", createdAt: 200 }),
    ];
    const result = groupSessionsByProject(sessions, new Map(), new Map());
    expect(result[0].key).toBe("/repo/new");
    expect(result[1].key).toBe("/repo/old");
  });

  it("handles monorepo (same repoRoot, different cwd)", () => {
    const sessions = [
      makeSession({ id: "s1", projectKey: "/monorepo", cwd: "/monorepo/packages/a" }),
      makeSession({ id: "s2", projectKey: "/monorepo", cwd: "/monorepo/packages/b" }),
    ];
    const result = groupSessionsByProject(sessions, new Map(), new Map());
    expect(result).toHaveLength(1);
    expect(result[0].sessions).toHaveLength(2);
  });
});
