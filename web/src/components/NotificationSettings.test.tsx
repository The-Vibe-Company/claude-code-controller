// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = {
  listNotificationProviders: vi.fn(),
  createNotificationProvider: vi.fn(),
  updateNotificationProvider: vi.fn(),
  deleteNotificationProvider: vi.fn(),
  testNotificationProvider: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    listNotificationProviders: (...args: unknown[]) =>
      mockApi.listNotificationProviders(...args),
    createNotificationProvider: (...args: unknown[]) =>
      mockApi.createNotificationProvider(...args),
    updateNotificationProvider: (...args: unknown[]) =>
      mockApi.updateNotificationProvider(...args),
    deleteNotificationProvider: (...args: unknown[]) =>
      mockApi.deleteNotificationProvider(...args),
    testNotificationProvider: (...args: unknown[]) =>
      mockApi.testNotificationProvider(...args),
  },
}));

import { NotificationSettings } from "./NotificationSettings.js";

const slackProvider = {
  id: "test-slack-1",
  type: "slack" as const,
  name: "My Slack",
  enabled: true,
  config: {
    type: "slack" as const,
    webhookUrl: "https://hooks.slack.com/services/test",
  },
  triggers: ["session_complete" as const],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listNotificationProviders.mockResolvedValue([]);
});

describe("NotificationSettings", () => {
  it("loads providers on mount and shows empty state", async () => {
    render(<NotificationSettings />);

    await waitFor(() => {
      expect(mockApi.listNotificationProviders).toHaveBeenCalledTimes(1);
    });

    expect(
      screen.getByText(/No notification providers configured/),
    ).toBeInTheDocument();
  });

  it("renders provider list when providers exist", async () => {
    mockApi.listNotificationProviders.mockResolvedValueOnce([slackProvider]);

    render(<NotificationSettings />);

    expect(await screen.findByText("My Slack")).toBeInTheDocument();
    expect(screen.getByText("Slack")).toBeInTheDocument();
    expect(screen.getByText("On")).toBeInTheDocument();
  });

  it("shows Add Provider button", async () => {
    render(<NotificationSettings />);
    await waitFor(() => {
      expect(mockApi.listNotificationProviders).toHaveBeenCalled();
    });

    expect(
      screen.getByRole("button", { name: "Add Provider" }),
    ).toBeInTheDocument();
  });

  it("opens form when Add Provider is clicked", async () => {
    render(<NotificationSettings />);
    await waitFor(() => {
      expect(mockApi.listNotificationProviders).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Provider" }));

    expect(screen.getByText("Provider Type")).toBeInTheDocument();
    expect(screen.getByText("Name")).toBeInTheDocument();
  });

  it("toggles enabled/disabled when toggle is clicked", async () => {
    mockApi.listNotificationProviders.mockResolvedValueOnce([slackProvider]);
    mockApi.updateNotificationProvider.mockResolvedValueOnce({
      ...slackProvider,
      enabled: false,
    });
    // After toggle, re-fetch returns updated
    mockApi.listNotificationProviders.mockResolvedValueOnce([
      { ...slackProvider, enabled: false },
    ]);

    render(<NotificationSettings />);
    await screen.findByText("My Slack");

    fireEvent.click(screen.getByText("On"));

    await waitFor(() => {
      expect(mockApi.updateNotificationProvider).toHaveBeenCalledWith(
        "test-slack-1",
        { enabled: false },
      );
    });
  });

  it("deletes a provider", async () => {
    mockApi.listNotificationProviders.mockResolvedValueOnce([slackProvider]);
    mockApi.deleteNotificationProvider.mockResolvedValueOnce({ ok: true });
    mockApi.listNotificationProviders.mockResolvedValueOnce([]);

    render(<NotificationSettings />);
    await screen.findByText("My Slack");

    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(mockApi.deleteNotificationProvider).toHaveBeenCalledWith(
        "test-slack-1",
      );
    });
  });

  it("calls test API when Test button is clicked", async () => {
    mockApi.listNotificationProviders.mockResolvedValueOnce([slackProvider]);
    mockApi.testNotificationProvider.mockResolvedValueOnce({ success: true });

    render(<NotificationSettings />);
    await screen.findByText("My Slack");

    fireEvent.click(screen.getByText("Test"));

    await waitFor(() => {
      expect(mockApi.testNotificationProvider).toHaveBeenCalledWith(
        "test-slack-1",
      );
    });

    expect(
      await screen.findByText("Test notification sent successfully."),
    ).toBeInTheDocument();
  });

  it("shows error when test fails", async () => {
    mockApi.listNotificationProviders.mockResolvedValueOnce([slackProvider]);
    mockApi.testNotificationProvider.mockResolvedValueOnce({
      success: false,
      error: "Webhook returned 403",
    });

    render(<NotificationSettings />);
    await screen.findByText("My Slack");

    fireEvent.click(screen.getByText("Test"));

    expect(
      await screen.findByText("Test failed: Webhook returned 403"),
    ).toBeInTheDocument();
  });

  it("shows trigger badges on provider cards", async () => {
    mockApi.listNotificationProviders.mockResolvedValueOnce([slackProvider]);

    render(<NotificationSettings />);
    await screen.findByText("My Slack");

    expect(screen.getByText("Session Complete")).toBeInTheDocument();
  });
});
