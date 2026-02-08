import { readUnread, parseMessage } from "./inbox.js";
import { defaultPaths, type ClaudePaths } from "./paths.js";
import type { InboxMessage, Logger, StructuredMessage } from "./types.js";

export interface PollEvent {
  raw: InboxMessage;
  parsed: StructuredMessage;
}

/**
 * Polls an agent's inbox for new messages.
 * Used by the controller to watch its own inbox for responses from agents.
 */
export class InboxPoller {
  private teamName: string;
  private agentName: string;
  private interval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private log: Logger;
  private handlers: ((events: PollEvent[]) => void)[] = [];
  private paths: ClaudePaths;

  constructor(
    teamName: string,
    agentName: string,
    logger: Logger,
    opts?: { pollInterval?: number; paths?: ClaudePaths }
  ) {
    this.teamName = teamName;
    this.agentName = agentName;
    this.log = logger;
    this.interval = opts?.pollInterval ?? 500;
    this.paths = opts?.paths ?? defaultPaths;
  }

  /**
   * Register a handler for new messages.
   */
  onMessages(handler: (events: PollEvent[]) => void): void {
    this.handlers.push(handler);
  }

  /**
   * Start polling.
   */
  start(): void {
    if (this.timer) return;
    this.log.debug(
      `Starting inbox poller for "${this.agentName}" (interval=${this.interval}ms)`
    );
    this.timer = setInterval(() => this.poll(), this.interval);
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log.debug(`Stopped inbox poller for "${this.agentName}"`);
    }
  }

  /**
   * Poll once for new messages.
   */
  async poll(): Promise<PollEvent[]> {
    try {
      const unread = await readUnread(this.teamName, this.agentName, {
        paths: this.paths,
      });
      if (unread.length === 0) return [];

      const events: PollEvent[] = unread.map((raw) => ({
        raw,
        parsed: parseMessage(raw),
      }));

      for (const handler of this.handlers) {
        try {
          handler(events);
        } catch (err) {
          this.log.error("Inbox handler error:", String(err));
        }
      }

      return events;
    } catch (err) {
      this.log.error("Inbox poll error:", String(err));
      return [];
    }
  }
}
