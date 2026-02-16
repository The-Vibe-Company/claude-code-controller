import { describe, it, expect } from "vitest";
import { getPromptTelemetry } from "./analytics-events.js";

describe("getPromptTelemetry", () => {
  it("buckets empty messages as zeros and no attachment", () => {
    const result = getPromptTelemetry("   ", 0);
    expect(result).toEqual({
      prompt_length_bucket: "0",
      prompt_word_count_bucket: "0",
      attachment_count_bucket: "0",
      has_attachments: false,
    });
  });

  it("produces larger buckets for longer prompts with attachments", () => {
    const result = getPromptTelemetry(
      "Refactor the billing module and add error handling around the external client call.",
      3,
    );
    expect(result).toEqual(expect.objectContaining({
      prompt_length_bucket: "81-200",
      prompt_word_count_bucket: "11-25",
      attachment_count_bucket: "3-5",
      has_attachments: true,
    }));
  });
});
