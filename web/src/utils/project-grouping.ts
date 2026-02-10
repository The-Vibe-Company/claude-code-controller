import type { SidebarSession, SidebarProject } from "../types.js";

/**
 * Derive a display name from a project key (filesystem path).
 * Uses the last path segment, e.g. "/Users/foo/projects/my-app" → "my-app"
 */
export function deriveProjectName(key: string): string {
  const segments = key.replace(/\/+$/, "").split("/");
  return segments[segments.length - 1] || key;
}

/**
 * Groups sessions by projectKey and returns sorted project groups.
 * Sorting: projects with running sessions first, then by most recent session.
 */
export function groupSessionsByProject(
  sessions: SidebarSession[],
  projectNames: Map<string, string>,
  sessionCosts: Map<string, number>,
): SidebarProject[] {
  const groups = new Map<string, SidebarSession[]>();

  for (const s of sessions) {
    const key = s.projectKey || s.cwd || "unknown";
    const group = groups.get(key) || [];
    group.push(s);
    groups.set(key, group);
  }

  const projects: SidebarProject[] = [];
  for (const [key, groupSessions] of groups) {
    const name = projectNames.get(key) || deriveProjectName(key);
    const activeSessions = groupSessions.filter((s) => !s.archived).length;
    const totalCost = groupSessions.reduce(
      (sum, s) => sum + (sessionCosts.get(s.id) ?? 0),
      0,
    );

    projects.push({
      key,
      name,
      sessions: groupSessions,
      activeSessions,
      totalCost,
    });
  }

  // Sort: projects with running sessions first, then by most recent activity
  projects.sort((a, b) => {
    const aHasRunning = a.sessions.some((s) => s.status === "running" || s.status === "compacting");
    const bHasRunning = b.sessions.some((s) => s.status === "running" || s.status === "compacting");
    if (aHasRunning !== bHasRunning) return aHasRunning ? -1 : 1;

    const aLatest = Math.max(...a.sessions.map((s) => s.createdAt ?? 0));
    const bLatest = Math.max(...b.sessions.map((s) => s.createdAt ?? 0));
    return bLatest - aLatest;
  });

  return projects;
}
