import { execSync } from "node:child_process";

let resolvedBinary: string | null = null;

function resolveClaudeBinary(): string {
  if (resolvedBinary) return resolvedBinary;
  try {
    resolvedBinary = execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    resolvedBinary = "claude";
  }
  return resolvedBinary;
}

/**
 * Spawns a one-shot Claude Code CLI process to generate a short session title
 * from the user's first message. Uses the same model as the session.
 *
 * Returns the generated title, or null if generation fails.
 */
export async function generateSessionTitle(
  firstUserMessage: string,
  model: string,
  options?: {
    claudeBinary?: string;
    timeoutMs?: number;
  },
): Promise<string | null> {
  const binary = options?.claudeBinary || resolveClaudeBinary();
  const timeout = options?.timeoutMs || 15_000;

  // Truncate message to keep the prompt small
  const truncated = firstUserMessage.slice(0, 500);

  const prompt = `Generate a concise 3-5 word session title for this user request. Output ONLY the title, nothing else.\n\nRequest: ${truncated}`;

  try {
    const proc = Bun.spawn(
      [binary, "-p", prompt, "--model", model, "--output-format", "json"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env as Record<string, string>,
      },
    );

    // Race between completion and timeout
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

    // Parse JSON output: { "result": "the title text", ... }
    try {
      const parsed = JSON.parse(stdout);
      const title = (parsed.result || "").trim();
      if (title && title.length > 0 && title.length < 100) {
        return title.replace(/^["']|["']$/g, "").trim();
      }
    } catch {
      // If not valid JSON, try using raw stdout
      const raw = stdout.trim();
      if (raw && raw.length > 0 && raw.length < 100) {
        return raw.replace(/^["']|["']$/g, "").trim();
      }
    }

    return null;
  } catch (err) {
    console.warn("[auto-namer] Failed to generate session title:", err);
    return null;
  }
}
