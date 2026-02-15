// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const apiMock = vi.hoisted(() => ({
  listPlugins: vi.fn(),
  enablePlugin: vi.fn(),
  disablePlugin: vi.fn(),
  updatePluginConfig: vi.fn(),
}));

vi.mock("../api.js", () => ({
  api: apiMock,
}));

import { PluginsPage } from "./PluginsPage.js";
import { useStore } from "../store.js";

beforeEach(() => {
  vi.clearAllMocks();
  useStore.getState().reset();
  apiMock.listPlugins.mockResolvedValue([
    {
      id: "notifications",
      name: "Session Notifications",
      version: "1.0.0",
      description: "Generates plugin notifications",
      events: ["result.received"],
      priority: 50,
      blocking: true,
      timeoutMs: 1000,
      failPolicy: "continue",
      enabled: true,
      config: { onResultError: true },
    },
  ]);
  apiMock.disablePlugin.mockResolvedValue({
    id: "notifications",
    name: "Session Notifications",
    version: "1.0.0",
    description: "Generates plugin notifications",
    events: ["result.received"],
    priority: 50,
    blocking: true,
    timeoutMs: 1000,
    failPolicy: "continue",
    enabled: false,
    config: { onResultError: true },
  });
  apiMock.enablePlugin.mockResolvedValue({
    id: "notifications",
    name: "Session Notifications",
    version: "1.0.0",
    description: "Generates plugin notifications",
    events: ["result.received"],
    priority: 50,
    blocking: true,
    timeoutMs: 1000,
    failPolicy: "continue",
    enabled: true,
    config: { onResultError: true },
  });
  apiMock.updatePluginConfig.mockResolvedValue({
    id: "notifications",
    name: "Session Notifications",
    version: "1.0.0",
    description: "Generates plugin notifications",
    events: ["result.received"],
    priority: 50,
    blocking: true,
    timeoutMs: 1000,
    failPolicy: "continue",
    enabled: true,
    config: { onResultError: false },
  });
});

describe("PluginsPage", () => {
  it("loads and renders plugins", async () => {
    render(<PluginsPage embedded />);
    expect(await screen.findByText("Session Notifications")).toBeInTheDocument();
    expect(apiMock.listPlugins).toHaveBeenCalledTimes(1);
  });

  it("toggles plugin enabled state", async () => {
    render(<PluginsPage embedded />);
    const button = await screen.findByRole("button", { name: "Enabled" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(apiMock.disablePlugin).toHaveBeenCalledWith("notifications");
    });
  });

  it("pins plugin to taskbar", async () => {
    render(<PluginsPage embedded />);
    const pinButton = await screen.findByRole("button", { name: "Pin to taskbar" });
    fireEvent.click(pinButton);

    await waitFor(() => {
      expect(useStore.getState().taskbarPluginPins.has("notifications")).toBe(true);
    });
  });

  it("preserves unsaved config draft when toggling another plugin", async () => {
    apiMock.listPlugins
      .mockResolvedValueOnce([
        {
          id: "notifications",
          name: "Session Notifications",
          version: "1.0.0",
          description: "Generates plugin notifications",
          events: ["result.received"],
          priority: 50,
          blocking: true,
          timeoutMs: 1000,
          failPolicy: "continue",
          enabled: true,
          config: { onResultError: true },
        },
        {
          id: "permission-automation",
          name: "Permission Automation",
          version: "1.0.0",
          description: "Automates permission requests",
          events: ["permission.requested"],
          priority: 1000,
          blocking: true,
          timeoutMs: 1000,
          failPolicy: "abort_current_action",
          enabled: true,
          config: { rules: [] },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "notifications",
          name: "Session Notifications",
          version: "1.0.0",
          description: "Generates plugin notifications",
          events: ["result.received"],
          priority: 50,
          blocking: true,
          timeoutMs: 1000,
          failPolicy: "continue",
          enabled: true,
          config: { onResultError: true },
        },
        {
          id: "permission-automation",
          name: "Permission Automation",
          version: "1.0.0",
          description: "Automates permission requests",
          events: ["permission.requested"],
          priority: 1000,
          blocking: true,
          timeoutMs: 1000,
          failPolicy: "abort_current_action",
          enabled: false,
          config: { rules: [] },
        },
      ]);
    apiMock.disablePlugin.mockResolvedValueOnce({
      id: "permission-automation",
      name: "Permission Automation",
      version: "1.0.0",
      description: "Automates permission requests",
      events: ["permission.requested"],
      priority: 1000,
      blocking: true,
      timeoutMs: 1000,
      failPolicy: "abort_current_action",
      enabled: false,
      config: { rules: [] },
    });

    render(<PluginsPage embedded />);
    await screen.findByText("Permission Automation");

    const editors = screen.getAllByRole("textbox");
    fireEvent.change(editors[0], { target: { value: '{\n  "onResultError": false\n}' } });

    const toggles = screen.getAllByRole("button", { name: "Enabled" });
    fireEvent.click(toggles[1]);

    // Editing one plugin must survive refreshes triggered by a different plugin action.
    await waitFor(() => {
      expect(editors[0]).toHaveValue('{\n  "onResultError": false\n}');
    });
  });
});
