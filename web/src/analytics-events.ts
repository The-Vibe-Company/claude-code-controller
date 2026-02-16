export interface PromptTelemetry {
  prompt_length_bucket: string;
  prompt_word_count_bucket: string;
  attachment_count_bucket: string;
  has_attachments: boolean;
}

function bucketForNumber(value: number, boundaries: number[], labels: string[]): string {
  for (let i = 0; i < boundaries.length; i++) {
    if (value <= boundaries[i]) return labels[i];
  }
  return labels[labels.length - 1];
}

export function getPromptTelemetry(message: string, attachmentCount: number): PromptTelemetry {
  const clean = message.trim();
  const length = clean.length;
  const wordCount = clean.length ? clean.split(/\s+/).filter(Boolean).length : 0;

  return {
    prompt_length_bucket: bucketForNumber(
      length,
      [0, 30, 80, 200, 500, 1200],
      ["0", "1-30", "31-80", "81-200", "201-500", "501-1200", "1201+"],
    ),
    prompt_word_count_bucket: bucketForNumber(
      wordCount,
      [0, 4, 10, 25, 50, 100],
      ["0", "1-4", "5-10", "11-25", "26-50", "51-100", "100+"],
    ),
    attachment_count_bucket: bucketForNumber(
      attachmentCount,
      [0, 1, 2, 5],
      ["0", "1", "2", "3-5", "6+"],
    ),
    has_attachments: attachmentCount > 0,
  };
}
