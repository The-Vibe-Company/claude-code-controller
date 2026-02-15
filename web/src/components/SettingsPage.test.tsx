// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

interface MockStoreState {
  darkMode: boolean;
  notificationSound: boolean;
  notificationDesktop: boolean;
  updateInfo: {
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    isServiceMode: boolean;
    updateInProgress: boolean;
    lastChecked: number;
  } | null;
  toggleDarkMode: ReturnType<typeof vi.fn>;
  toggleNotificationSound: ReturnType<typeof vi.fn>;
  setNotificationDesktop: ReturnType<typeof vi.fn>;
  setUpdateInfo: ReturnType<typeof vi.fn>;
}

let mockState: MockStoreState;

function createMockState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    darkMode: false,
    notificationSound: true,
    notificationDesktop: false,
    updateInfo: null,
    toggleDarkMode: vi.fn(),
    toggleNotificationSound: vi.fn(),
    setNotificationDesktop: vi.fn(),
    setUpdateInfo: vi.fn(),
    ...overrides,
  };
}

const mockApi = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  forceCheckForUpdate: vi.fn(),
  triggerUpdate: vi.fn(),
};

const mockTelemetry = {
  getTelemetryPreferenceEnabled: vi.fn(),
  setTelemetryPreferenceEnabled: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
    updateSettings: (...args: unknown[]) => mockApi.updateSettings(...args),
    forceCheckForUpdate: (...args: unknown[]) => mockApi.forceCheckForUpdate(...args),
    triggerUpdate: (...args: unknown[]) => mockApi.triggerUpdate(...args),
  },
}));

vi.mock("../analytics.js", () => ({
  getTelemetryPreferenceEnabled: (...args: unknown[]) => mockTelemetry.getTelemetryPreferenceEnabled(...args),
  setTelemetryPreferenceEnabled: (...args: unknown[]) => mockTelemetry.setTelemetryPreferenceEnabled(...args),
}));

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

import { SettingsPage } from "./SettingsPage.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockState = createMockState();
  window.location.hash = "#/settings";
  mockApi.getSettings.mockResolvedValue({
    openrouterApiKeyConfigured: true,
    openrouterModel: "openrouter/free",
  });
  mockApi.updateSettings.mockResolvedValue({
    openrouterApiKeyConfigured: true,
    openrouterModel: "openrouter/free",
  });
  mockApi.forceCheckForUpdate.mockResolvedValue({
    currentVersion: "0.22.1",
    latestVersion: null,
    updateAvailable: false,
    isServiceMode: false,
    updateInProgress: false,
    lastChecked: Date.now(),
  });
  mockApi.triggerUpdate.mockResolvedValue({
    ok: true,
    message: "Update started. Server will restart shortly.",
  });
  mockTelemetry.getTelemetryPreferenceEnabled.mockReturnValue(true);
});

describe("SettingsPage", () => {
  it("loads settings on mount and shows configured status", async () => {
    render(<SettingsPage />);

    expect(mockApi.getSettings).toHaveBeenCalledTimes(1);
    await screen.findByText("OpenRouter key configured");
    expect(screen.getByDisplayValue("openrouter/free")).toBeInTheDocument();
  });

  it("shows not configured status", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      openrouterApiKeyConfigured: false,
      openrouterModel: "openrouter/free",
    });

    render(<SettingsPage />);

    await screen.findByText("OpenRouter key not configured");
  });

  it("shows the auto-renaming helper copy under the API key input", async () => {
    render(<SettingsPage />);

    expect(await screen.findByText("Auto-renaming is disabled until this key is configured.")).toBeInTheDocument();
  });

  it("saves settings with trimmed values", async () => {
    render(<SettingsPage />);
    await screen.findByText("OpenRouter key configured");

    fireEvent.change(screen.getByLabelText("OpenRouter API Key"), {
      target: { value: "  or-key  " },
    });
    fireEvent.change(screen.getByLabelText("OpenRouter Model"), {
      target: { value: "  openai/gpt-4o-mini  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        openrouterApiKey: "or-key",
        openrouterModel: "openai/gpt-4o-mini",
      });
    });

    expect(await screen.findByText("Settings saved.")).toBeInTheDocument();
  });

  it("falls back model to openrouter/free when blank", async () => {
    render(<SettingsPage />);
    await screen.findByText("OpenRouter key configured");
    fireEvent.change(screen.getByLabelText("OpenRouter Model"), {
      target: { value: "   " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        openrouterModel: "openrouter/free",
      });
    });
  });

  it("does not send key when left empty", async () => {
    render(<SettingsPage />);
    await screen.findByText("OpenRouter key configured");

    fireEvent.change(screen.getByLabelText("OpenRouter Model"), {
      target: { value: "openai/gpt-4o-mini" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        openrouterModel: "openai/gpt-4o-mini",
      });
    });
  });

  it("shows error if initial load fails", async () => {
    mockApi.getSettings.mockRejectedValueOnce(new Error("load failed"));

    render(<SettingsPage />);

    expect(await screen.findByText("load failed")).toBeInTheDocument();
  });

  it("shows error if save fails", async () => {
    mockApi.updateSettings.mockRejectedValueOnce(new Error("save failed"));

    render(<SettingsPage />);
    await screen.findByText("OpenRouter key configured");

    fireEvent.change(screen.getByLabelText("OpenRouter API Key"), {
      target: { value: "or-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("save failed")).toBeInTheDocument();
  });

  it("navigates back when Back button is clicked", async () => {
    render(<SettingsPage />);
    await screen.findByText("OpenRouter key configured");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(window.location.hash).toBe("");
  });

  it("hides Back button in embedded mode", async () => {
    render(<SettingsPage embedded />);
    await screen.findByText("OpenRouter key configured");
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("shows saving state while request is in flight", async () => {
    let resolveSave: ((value: {
      openrouterApiKeyConfigured: boolean;
      openrouterModel: string;
    }) => void) | undefined;
    mockApi.updateSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve as typeof resolveSave;
      }),
    );

    render(<SettingsPage />);
    await screen.findByText("OpenRouter key configured");

    fireEvent.change(screen.getByLabelText("OpenRouter API Key"), {
      target: { value: "or-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();

    resolveSave?.({
      openrouterApiKeyConfigured: true,
      openrouterModel: "openrouter/free",
    });

    await screen.findByText("Settings saved.");
  });

  it("toggles sound notifications from settings", async () => {
    render(<SettingsPage />);
    await screen.findByText("OpenRouter key configured");

    fireEvent.click(screen.getByRole("button", { name: /Sound/i }));
    expect(mockState.toggleNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("toggles theme from settings", async () => {
    mockState = createMockState({ darkMode: true });
    render(<SettingsPage />);
    await screen.findByText("OpenRouter key configured");

    fireEvent.click(screen.getByRole("button", { name: /Theme/i }));
    expect(mockState.toggleDarkMode).toHaveBeenCalledTimes(1);
  });

  it("toggles telemetry preference from settings", async () => {
    render(<SettingsPage />);
    await screen.findByText("OpenRouter key configured");

    fireEvent.click(screen.getByRole("button", { name: /Usage analytics and errors/i }));
    expect(mockTelemetry.setTelemetryPreferenceEnabled).toHaveBeenCalledWith(false);
  });

  it("navigates to environments page from settings", async () => {
    render(<SettingsPage />);
    await screen.findByText("OpenRouter key configured");

    fireEvent.click(screen.getByRole("button", { name: "Open Environments Page" }));
    expect(window.location.hash).toBe("#/environments");
  });

  it("requests desktop permission before enabling desktop alerts", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission,
    });

    render(<SettingsPage />);
    await screen.findByText("OpenRouter key configured");
    fireEvent.click(screen.getByRole("button", { name: /Desktop Alerts/i }));

    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(mockState.setNotificationDesktop).toHaveBeenCalledWith(true);
    });
    vi.unstubAllGlobals();
  });

  it("checks for updates from settings and stores update info", async () => {
    mockApi.forceCheckForUpdate.mockResolvedValueOnce({
      currentVersion: "0.22.1",
      latestVersion: "0.23.0",
      updateAvailable: true,
      isServiceMode: true,
      updateInProgress: false,
      lastChecked: Date.now(),
    });

    render(<SettingsPage />);
    await screen.findByText("OpenRouter key configured");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => {
      expect(mockApi.forceCheckForUpdate).toHaveBeenCalledTimes(1);
      expect(mockState.setUpdateInfo).toHaveBeenCalledWith(expect.objectContaining({
        latestVersion: "0.23.0",
        updateAvailable: true,
      }));
    });
    expect(await screen.findByText("Update v0.23.0 is available.")).toBeInTheDocument();
  });

  it("triggers app update from settings when service mode is enabled", async () => {
    mockState = createMockState({
      updateInfo: {
        currentVersion: "0.22.1",
        latestVersion: "0.23.0",
        updateAvailable: true,
        isServiceMode: true,
        updateInProgress: false,
        lastChecked: Date.now(),
      },
    });
    render(<SettingsPage />);
    await screen.findByText("OpenRouter key configured");

    fireEvent.click(screen.getByRole("button", { name: "Update & Restart" }));

    await waitFor(() => {
      expect(mockApi.triggerUpdate).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText("Update started. Server will restart shortly.")).toBeInTheDocument();
  });
});
