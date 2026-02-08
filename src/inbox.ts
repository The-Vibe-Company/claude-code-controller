import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";
import { defaultPaths, type ClaudePaths } from "./paths.js";
import type { InboxMessage, Logger, StructuredMessage } from "./types.js";

const LOCK_OPTIONS = {
  retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
  stale: 10_000,
};

async function ensureDir(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function ensureFile(filePath: string): Promise<void> {
  await ensureDir(filePath);
  if (!existsSync(filePath)) {
    await writeFile(filePath, "[]", "utf-8");
  }
}

/**
 * Write a message to an agent's inbox with file-locking.
 */
export async function writeInbox(
  teamName: string,
  agentName: string,
  message: Omit<InboxMessage, "read">,
  logger?: Logger,
  opts?: { paths?: ClaudePaths }
): Promise<void> {
  const paths = opts?.paths ?? defaultPaths;
  const path = paths.inboxPath(teamName, agentName);
  await ensureFile(path);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(path, LOCK_OPTIONS);
    const raw = await readFile(path, "utf-8");
    const messages: InboxMessage[] = JSON.parse(raw || "[]");
    messages.push({ ...message, read: false });
    await writeFile(path, JSON.stringify(messages, null, 2), "utf-8");
    logger?.debug(`Wrote message to inbox ${agentName}`, message.from);
  } finally {
    if (release) await release();
  }
}

/**
 * Read all messages from an agent's inbox.
 */
export async function readInbox(
  teamName: string,
  agentName: string,
  opts?: { paths?: ClaudePaths }
): Promise<InboxMessage[]> {
  const paths = opts?.paths ?? defaultPaths;
  const path = paths.inboxPath(teamName, agentName);
  if (!existsSync(path)) return [];

  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw || "[]");
}

/**
 * Read unread messages from an agent's inbox and mark them as read.
 */
export async function readUnread(
  teamName: string,
  agentName: string,
  opts?: { paths?: ClaudePaths }
): Promise<InboxMessage[]> {
  const paths = opts?.paths ?? defaultPaths;
  const path = paths.inboxPath(teamName, agentName);
  if (!existsSync(path)) return [];

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(path, LOCK_OPTIONS);
    const raw = await readFile(path, "utf-8");
    const messages: InboxMessage[] = JSON.parse(raw || "[]");

    const unread = messages.filter((m) => !m.read);
    if (unread.length === 0) return [];

    // Mark all as read
    for (const m of messages) {
      m.read = true;
    }
    await writeFile(path, JSON.stringify(messages, null, 2), "utf-8");
    return unread;
  } finally {
    if (release) await release();
  }
}

/**
 * Parse a structured message from an inbox message's text field.
 * Messages can be either JSON-encoded structured messages or plain text.
 */
export function parseMessage(msg: InboxMessage): StructuredMessage {
  try {
    const parsed = JSON.parse(msg.text);
    if (parsed && typeof parsed === "object" && "type" in parsed) {
      return parsed as StructuredMessage;
    }
  } catch {
    // Not JSON, treat as plain text
  }
  return { type: "plain_text", text: msg.text };
}
