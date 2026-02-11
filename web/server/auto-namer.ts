import { execSync } from "node:child_process";
import type { BackendType } from "./session-types.js";

let resolvedClaudeBinary: string | null = null;
let resolvedCodexBinary: string | null = null;

function resolveClaudeBinary(): string {
  if (resolvedClaudeBinary) return resolvedClaudeBinary;
  try {
    resolvedClaudeBinary = execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    resolvedClaudeBinary = "claude";
  }
  return resolvedClaudeBinary;
}

function resolveCodexBinary(): string {
  if (resolvedCodexBinary) return resolvedCodexBinary;
  try {
    resolvedCodexBinary = execSync("which codex", { encoding: "utf-8" }).trim();
  } catch {
    resolvedCodexBinary = "codex";
  }
  return resolvedCodexBinary;
}

/**
 * Spawns a one-shot CLI process to generate a short session title
 * from the user's first message. Supports both Claude Code and Codex backends.
 *
 * Returns the generated title, or null if generation fails.
 */
export async function generateSessionTitle(
  firstUserMessage: string,
  model: string,
  options?: {
    claudeBinary?: string;
    codexBinary?: string;
    backendType?: BackendType;
    timeoutMs?: number;
  },
): Promise<string | null> {
  const backendType = options?.backendType || "claude";
  const timeout = options?.timeoutMs || 15_000;

  // Truncate message to keep the prompt small
  const truncated = firstUserMessage.slice(0, 500);
  const prompt = `Generate a concise 3-5 word session title for this user request. Output ONLY the title, nothing else.\n\nRequest: ${truncated}`;

  if (backendType === "codex") {
    return generateTitleViaCodex(prompt, model, timeout, options?.codexBinary);
  }
  return generateTitleViaClaude(prompt, model, timeout, options?.claudeBinary);
}

async function generateTitleViaClaude(
  prompt: string,
  model: string,
  timeout: number,
  binaryOverride?: string,
): Promise<string | null> {
  const binary = binaryOverride || resolveClaudeBinary();

  try {
    const proc = Bun.spawn(
      [binary, "-p", prompt, "--model", model, "--output-format", "json"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      },
    );

    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          proc.kill("SIGTERM");
          reject(new Error("Auto-naming timed out"));
        }, timeout);
      }),
    ]);
    clearTimeout(timer!);

    const stdout = await new Response(proc.stdout).text();

    try {
      const parsed = JSON.parse(stdout);
      const title = (parsed.result || "").trim();
      if (title && title.length > 0 && title.length < 100) {
        return title.replace(/^["']|["']$/g, "").trim();
      }
    } catch {
      const raw = stdout.trim();
      if (raw && raw.length > 0 && raw.length < 100) {
        return raw.replace(/^["']|["']$/g, "").trim();
      }
    }

    return null;
  } catch (err) {
    console.warn("[auto-namer] Failed to generate session title via Claude:", err);
    return null;
  }
}

async function generateTitleViaCodex(
  prompt: string,
  model: string,
  timeout: number,
  binaryOverride?: string,
): Promise<string | null> {
  const binary = binaryOverride || resolveCodexBinary();

  try {
    const proc = Bun.spawn(
      [binary, "exec", "-q", prompt, "--model", model, "--json"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      },
    );

    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          proc.kill("SIGTERM");
          reject(new Error("Auto-naming timed out"));
        }, timeout);
      }),
    ]);
    clearTimeout(timer!);

    const stdout = await new Response(proc.stdout).text();

    // Codex exec --json outputs JSONL events. Find the last item.completed with agentMessage
    const lines = stdout.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          const text = event.item.text || "";
          if (text.length > 0 && text.length < 100) {
            return text.replace(/^["']|["']$/g, "").trim();
          }
        }
      } catch { continue; }
    }

    // Fallback: try to extract text from any completed item
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (event.item?.text) {
          const text = event.item.text.trim();
          if (text.length > 0 && text.length < 100) {
            return text.replace(/^["']|["']$/g, "").trim();
          }
        }
      } catch { continue; }
    }

    return null;
  } catch (err) {
    console.warn("[auto-namer] Failed to generate session title via Codex:", err);
    return null;
  }
}
