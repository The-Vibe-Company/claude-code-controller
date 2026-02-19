// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const startEditorMock = vi.hoisted(() => vi.fn());

vi.mock("../api.js", () => ({
  api: {
    startEditor: startEditorMock,
  },
}));

import { SessionEditorPane } from "./SessionEditorPane.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SessionEditorPane", () => {
  it("renders unavailable message when editor is not installed", async () => {
    // Verifies explicit fallback text so users understand why the editor panel is empty.
    startEditorMock.mockResolvedValue({
      available: false,
      installed: false,
      mode: "host",
      message: "VS Code editor is not installed on this machine.",
    });

    render(<SessionEditorPane sessionId="s1" />);

    expect(screen.getByText("Starting VS Code editor...")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("VS Code editor unavailable")).toBeInTheDocument(),
    );
    expect(screen.getByText("VS Code editor is not installed on this machine.")).toBeInTheDocument();
  });

  it("renders embedded iframe when editor is available", async () => {
    // Confirms we mount the editor iframe and keep a manual fallback link.
    startEditorMock.mockResolvedValue({
      available: true,
      installed: true,
      mode: "container",
      url: "http://localhost:4040/?folder=%2Fworkspace",
    });

    render(<SessionEditorPane sessionId="s1" />);

    await waitFor(() =>
      expect(screen.getByTitle("VS Code editor")).toBeInTheDocument(),
    );
    const iframe = screen.getByTitle("VS Code editor");
    expect(iframe).toHaveAttribute("src", "http://localhost:4040/?folder=%2Fworkspace");
    expect(screen.getByRole("link", { name: "Open in new tab" })).toHaveAttribute(
      "href",
      "http://localhost:4040/?folder=%2Fworkspace",
    );
  });
});
