import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudePaths {
  /** Root Claude directory (default: ~/.claude) */
  claudeDir: string;
  teamsDir(): string;
  teamDir(teamName: string): string;
  teamConfigPath(teamName: string): string;
  inboxesDir(teamName: string): string;
  inboxPath(teamName: string, agentName: string): string;
  tasksBaseDir(): string;
  tasksDir(teamName: string): string;
  taskPath(teamName: string, taskId: string): string;
}

export function createPaths(opts?: { claudeDir?: string }): ClaudePaths {
  const claudeDir = opts?.claudeDir ?? join(homedir(), ".claude");

  const paths: ClaudePaths = {
    claudeDir,
    teamsDir: () => join(claudeDir, "teams"),
    teamDir: (teamName) => join(claudeDir, "teams", teamName),
    teamConfigPath: (teamName) =>
      join(claudeDir, "teams", teamName, "config.json"),
    inboxesDir: (teamName) => join(claudeDir, "teams", teamName, "inboxes"),
    inboxPath: (teamName, agentName) =>
      join(claudeDir, "teams", teamName, "inboxes", `${agentName}.json`),
    tasksBaseDir: () => join(claudeDir, "tasks"),
    tasksDir: (teamName) => join(claudeDir, "tasks", teamName),
    taskPath: (teamName, taskId) => join(claudeDir, "tasks", teamName, `${taskId}.json`),
  };

  return paths;
}

export const defaultPaths = createPaths();

export function teamsDir(): string {
  return defaultPaths.teamsDir();
}

export function teamDir(teamName: string): string {
  return defaultPaths.teamDir(teamName);
}

export function teamConfigPath(teamName: string): string {
  return defaultPaths.teamConfigPath(teamName);
}

export function inboxesDir(teamName: string): string {
  return defaultPaths.inboxesDir(teamName);
}

export function inboxPath(teamName: string, agentName: string): string {
  return defaultPaths.inboxPath(teamName, agentName);
}

export function tasksBaseDir(): string {
  return defaultPaths.tasksBaseDir();
}

export function tasksDir(teamName: string): string {
  return defaultPaths.tasksDir(teamName);
}

export function taskPath(teamName: string, taskId: string): string {
  return defaultPaths.taskPath(teamName, taskId);
}
