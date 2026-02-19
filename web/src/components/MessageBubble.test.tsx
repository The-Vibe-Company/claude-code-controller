// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import type { ChatMessage, ContentBlock } from "../types.js";

// Mock react-markdown to avoid ESM/parsing issues in tests
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

import { MessageBubble } from "./MessageBubble.js";

function makeMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── System messages ─────────────────────────────────────────────────────────

describe("MessageBubble - system messages", () => {
  it("renders system message with italic text", () => {
    const msg = makeMessage({ role: "system", content: "Session started" });
    const { container } = render(<MessageBubble message={msg} />);

    const italicSpan = container.querySelector(".italic");
    expect(italicSpan).toBeTruthy();
    expect(italicSpan?.textContent).toBe("Session started");
  });

  it("renders system message with divider lines", () => {
    const msg = makeMessage({ role: "system", content: "Divider test" });
    const { container } = render(<MessageBubble message={msg} />);

    // There should be 2 divider elements (h-px)
    const dividers = container.querySelectorAll(".h-px");
    expect(dividers.length).toBe(2);
  });
});

// ─── User messages ───────────────────────────────────────────────────────────

describe("MessageBubble - user messages", () => {
  it("renders user message right-aligned with content", () => {
    const msg = makeMessage({ role: "user", content: "Hello Claude" });
    const { container } = render(<MessageBubble message={msg} />);

    // Check for right-alignment (justify-end)
    const wrapper = container.querySelector(".justify-end");
    expect(wrapper).toBeTruthy();

    // Check content
    expect(screen.getByText("Hello Claude")).toBeTruthy();
  });

  it("renders user messages with image thumbnails", () => {
    const msg = makeMessage({
      role: "user",
      content: "See this image",
      images: [
        { media_type: "image/png", data: "abc123base64" },
        { media_type: "image/jpeg", data: "def456base64" },
      ],
    });
    const { container } = render(<MessageBubble message={msg} />);

    const images = container.querySelectorAll("img");
    expect(images.length).toBe(2);
    expect(images[0].getAttribute("src")).toBe("data:image/png;base64,abc123base64");
    expect(images[1].getAttribute("src")).toBe("data:image/jpeg;base64,def456base64");
    expect(images[0].getAttribute("alt")).toBe("attachment");
  });

  it("does not render images section when images array is empty", () => {
    const msg = makeMessage({ role: "user", content: "No images", images: [] });
    const { container } = render(<MessageBubble message={msg} />);

    const images = container.querySelectorAll("img");
    expect(images.length).toBe(0);
  });
});

// ─── Assistant messages ──────────────────────────────────────────────────────

describe("MessageBubble - assistant messages", () => {
  it("renders plain text assistant message with markdown", () => {
    const msg = makeMessage({ role: "assistant", content: "Hello world" });
    render(<MessageBubble message={msg} />);

    // Our mock renders content inside data-testid="markdown"
    const markdown = screen.getByTestId("markdown");
    expect(markdown.textContent).toBe("Hello world");
  });

  it("renders assistant message with text content blocks", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "text", text: "Here is the answer" },
      ],
    });
    render(<MessageBubble message={msg} />);

    const markdown = screen.getByTestId("markdown");
    expect(markdown.textContent).toBe("Here is the answer");
  });

  it("renders tool_use content blocks as ToolBlock components", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "pwd" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // ToolBlock renders with the label "Terminal" for Bash
    expect(screen.getByText("Terminal")).toBeTruthy();
    // And the preview should show the command
    expect(screen.getByText("pwd")).toBeTruthy();
  });

  it("renders thinking blocks with 'Reasoning' label and char count", () => {
    const thinkingText = "Let me analyze this problem step by step...";
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "thinking", thinking: thinkingText },
      ],
    });
    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Reasoning")).toBeTruthy();
    expect(screen.getByText(`${thinkingText.length} chars`)).toBeTruthy();
  });

  it("thinking blocks expand and collapse on click", () => {
    const thinkingText = "Deep analysis of the problem at hand.";
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "thinking", thinking: thinkingText },
      ],
    });
    const { container } = render(<MessageBubble message={msg} />);

    // Thinking content is visible by default
    expect(screen.getByText(thinkingText)).toBeTruthy();

    // Find and click the thinking button
    const thinkingButton = screen.getByText("Reasoning").closest("button")!;
    fireEvent.click(thinkingButton);

    // Now collapsed
    const preAfterCollapse = container.querySelector("pre");
    expect(preAfterCollapse?.textContent || "").not.toContain(thinkingText);

    // Click again to re-open
    fireEvent.click(thinkingButton);
    expect(screen.getByText(thinkingText)).toBeTruthy();
  });

  it("renders tool_result blocks with string content", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_result", tool_use_id: "tu-1", content: "Command output: success" },
      ],
    });
    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Command output: success")).toBeTruthy();
  });

  it("renders tool_result blocks with JSON content", () => {
    const jsonContent = [{ type: "text" as const, text: "nested result" }];
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_result", tool_use_id: "tu-2", content: jsonContent as unknown as string },
      ],
    });
    render(<MessageBubble message={msg} />);

    // The JSON.stringify of the content should be rendered
    const rendered = screen.getByText(JSON.stringify(jsonContent));
    expect(rendered).toBeTruthy();
  });

  it("renders tool_result error blocks with error styling", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_result", tool_use_id: "tu-3", content: "Error: file not found", is_error: true },
      ],
    });
    const { container } = render(<MessageBubble message={msg} />);

    expect(screen.getByText("Error: file not found")).toBeTruthy();
    // Check for error styling class
    const errorDiv = container.querySelector(".text-cc-error");
    expect(errorDiv).toBeTruthy();
  });

  it("renders non-error tool_result without error styling", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_result", tool_use_id: "tu-4", content: "Success output" },
      ],
    });
    const { container } = render(<MessageBubble message={msg} />);

    expect(screen.getByText("Success output")).toBeTruthy();
    const resultDiv = screen.getByText("Success output");
    expect(resultDiv.className).toContain("text-cc-muted");
    expect(resultDiv.className).not.toContain("text-cc-error");
  });

  it("renders Bash tool_result with last 20 lines and supports full output toggle", () => {
    const outputLines = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`).join("\n");
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-bash", name: "Bash", input: { command: "cat big.log" } },
        { type: "tool_result", tool_use_id: "tu-bash", content: outputLines },
      ],
    });
    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Output (last 20 lines)")).toBeTruthy();
    const resultPre = document.querySelector("pre");
    const tailLines = (resultPre?.textContent || "").split("\n");
    expect(tailLines.includes("line-1")).toBe(false);
    expect(tailLines.includes("line-25")).toBe(true);

    fireEvent.click(screen.getByText("Show full"));
    const fullPre = document.querySelector("pre");
    const fullLines = (fullPre?.textContent || "").split("\n");
    expect(fullLines.includes("line-1")).toBe(true);
    expect(screen.getByText("Show tail")).toBeTruthy();
  });
});

// ─── groupContentBlocks behavior (tested indirectly through MessageBubble) ──

describe("MessageBubble - content block grouping", () => {
  it("groups consecutive same-tool tool_use blocks together", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
        { type: "tool_use", id: "tu-2", name: "Read", input: { file_path: "/b.ts" } },
        { type: "tool_use", id: "tu-3", name: "Read", input: { file_path: "/c.ts" } },
      ],
    });
    const { container } = render(<MessageBubble message={msg} />);

    // When grouped, there should be a count badge showing "3"
    expect(screen.getByText("3")).toBeTruthy();
    // The label should appear once (grouped)
    const labels = screen.getAllByText("Read File");
    expect(labels.length).toBe(1);
  });

  it("does not group different tool types together", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
        { type: "tool_use", id: "tu-2", name: "Bash", input: { command: "ls" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // Both labels should appear separately
    expect(screen.getByText("Read File")).toBeTruthy();
    expect(screen.getByText("Terminal")).toBeTruthy();
  });

  it("renders a single tool_use without group count badge", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "echo hi" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // Should render Terminal label but no count badge
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.queryByText("1")).toBeNull();
  });

  it("groups same tools separated by non-tool blocks into separate groups", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
        { type: "text", text: "Let me check something else" },
        { type: "tool_use", id: "tu-2", name: "Read", input: { file_path: "/b.ts" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // The two Read tools should not be grouped since there is a text block between them
    const labels = screen.getAllByText("Read File");
    expect(labels.length).toBe(2);
  });
});
