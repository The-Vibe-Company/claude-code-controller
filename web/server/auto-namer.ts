import { DEFAULT_OPENROUTER_MODEL, getSettings } from "./settings-manager.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function sanitizeTitle(raw: string): string | null {
  const title = raw.replace(/^"|"$/g, "").replace(/^'|'$/g, "").trim();
  if (!title || title.length >= 100) return null;
  return title;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const maybe = item as { text?: unknown };
          return typeof maybe.text === "string" ? maybe.text : "";
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * Generates a short session title using OpenRouter.
 * Returns null if OpenRouter isn't configured or if generation fails.
 */
export async function generateSessionTitle(
  firstUserMessage: string,
  _model: string,
  options?: {
    timeoutMs?: number;
  },
): Promise<string | null> {
  const timeout = options?.timeoutMs || 15_000;
  const settings = getSettings();
  const apiKey = settings.openrouterApiKey.trim();

  if (!apiKey) {
    return null;
  }

  const model = settings.openrouterModel?.trim() || DEFAULT_OPENROUTER_MODEL;
  const truncated = firstUserMessage.slice(0, 500);
  const userPrompt = `Generate a concise 3-5 word session title for this user request. Output only the title.\n\nRequest: ${truncated}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[auto-namer] OpenRouter request failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json() as {
      choices?: Array<{
        message?: {
          content?: unknown;
        };
      }>;
    };

    const raw = extractTextContent(data.choices?.[0]?.message?.content);
    return sanitizeTitle(raw);
  } catch (err) {
    console.warn("[auto-namer] Failed to generate session title via OpenRouter:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
