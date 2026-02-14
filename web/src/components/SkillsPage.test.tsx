// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock setup ──────────────────────────────────────────────────────────────

interface MockStoreState {
  currentSessionId: string | null;
  sessions: Map<string, { cwd?: string }>;
  sdkSessions: { sessionId: string; cwd?: string }[];
}

let mockState: MockStoreState;

function createMockState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    currentSessionId: "session-1",
    sessions: new Map([["session-1", { cwd: "/test-project" }]]),
    sdkSessions: [],
    ...overrides,
  };
}

const mockApi = {
  listSkills: vi.fn(),
  installSkill: vi.fn(),
  uninstallSkill: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    listSkills: (...args: unknown[]) => mockApi.listSkills(...args),
    installSkill: (...args: unknown[]) => mockApi.installSkill(...args),
    uninstallSkill: (...args: unknown[]) => mockApi.uninstallSkill(...args),
  },
}));

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

import { SkillsPage } from "./SkillsPage.js";

// ─── Test data ────────────────────────────────────────────────────────────────

function createSkillsResponse() {
  return {
    plugins: [
      {
        name: "feature-dev",
        description: "Feature development tools",
        skills: [],
        commands: [
          {
            name: "feature-dev",
            description: "Guided feature development",
            source: "marketplace" as const,
            pluginName: "feature-dev",
            type: "command" as const,
            path: "/plugins/feature-dev/commands/feature-dev.md",
            frontmatter: {},
            installed: false,
          },
        ],
        agents: [
          {
            name: "code-reviewer",
            description: "Reviews code for quality",
            source: "marketplace" as const,
            pluginName: "feature-dev",
            type: "agent" as const,
            path: "/plugins/feature-dev/agents/code-reviewer.md",
            frontmatter: {},
            installed: false,
          },
        ],
        installed: false,
      },
      {
        name: "empty-plugin",
        description: "Plugin with no installable items",
        skills: [],
        commands: [],
        agents: [],
        installed: false,
      },
    ],
    userSkills: [
      {
        name: "my-installed-skill",
        description: "Already installed",
        source: "user" as const,
        type: "skill" as const,
        path: "/home/.claude/skills/my-installed-skill/SKILL.md",
        frontmatter: {},
        installed: true,
        installedScope: "user" as const,
      },
    ],
    projectSkills: [],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockState = createMockState();
  mockApi.listSkills.mockResolvedValue(createSkillsResponse());
});

describe("SkillsPage", () => {
  it("renders loading state then skills data", async () => {
    // Verifies the page shows a loading indicator before data arrives,
    // then renders the skills header and plugin list
    render(<SkillsPage />);

    expect(screen.getByText("Scanning skills...")).toBeInTheDocument();

    await screen.findByText("Skills");
    expect(screen.getByText("feature-dev")).toBeInTheDocument();
    expect(screen.queryByText("Scanning skills...")).not.toBeInTheDocument();
  });

  it("passes cwd from current session to listSkills", async () => {
    // Ensures the component reads the session cwd from the store
    // and passes it to the API so project-level skills are discovered
    render(<SkillsPage />);
    await screen.findByText("feature-dev");

    expect(mockApi.listSkills).toHaveBeenCalledWith("/test-project");
  });

  it("renders without cwd when no session is active", async () => {
    // When no session is selected, listSkills should receive undefined cwd
    mockState = createMockState({ currentSessionId: null });
    render(<SkillsPage />);
    await screen.findByText("feature-dev");

    expect(mockApi.listSkills).toHaveBeenCalledWith(undefined);
  });

  it("shows installed skills section", async () => {
    // Verifies installed skills from user/project are shown in the Installed section
    render(<SkillsPage />);

    await screen.findByText("my-installed-skill");
    expect(screen.getByText("Installed (1)")).toBeInTheDocument();
  });

  it("shows error state on API failure", async () => {
    // Verifies error feedback is displayed when the skills API fails
    mockApi.listSkills.mockRejectedValue(new Error("Network error"));
    render(<SkillsPage />);

    await screen.findByText("Network error");
  });

  it("filters plugins by search query", async () => {
    // Verifies the search input filters the plugin list by name/description
    render(<SkillsPage />);
    await screen.findByText("feature-dev");

    fireEvent.change(screen.getByPlaceholderText("Search skills, plugins, commands..."), {
      target: { value: "empty" },
    });

    // Only the matching plugin should remain
    expect(screen.getByText("empty-plugin")).toBeInTheDocument();
    expect(screen.queryByText("feature-dev")).not.toBeInTheDocument();
  });

  it("filters installed skills by search query", async () => {
    // Verifies search also filters the installed skills section
    render(<SkillsPage />);
    await screen.findByText("my-installed-skill");

    fireEvent.change(screen.getByPlaceholderText("Search skills, plugins, commands..."), {
      target: { value: "nonexistent" },
    });

    expect(screen.queryByText("my-installed-skill")).not.toBeInTheDocument();
  });

  it("expands a plugin to show individual items", async () => {
    // Verifies clicking a plugin card expands it to show
    // individual skills/commands/agents with install buttons
    render(<SkillsPage />);
    await screen.findByText("feature-dev");

    // Click the plugin header to expand
    fireEvent.click(screen.getByText("feature-dev"));

    // Should show the individual items
    await waitFor(() => {
      expect(screen.getByText("code-reviewer")).toBeInTheDocument();
    });
  });

  it("shows success feedback after installing a skill", async () => {
    // Verifies the install flow: click Install > select scope > success toast.
    // The ScopeMenu uses createPortal to document.body.
    // The expanded plugin shows items in order: feature-dev (command), code-reviewer (agent).
    // We target the second Install button (code-reviewer).
    mockApi.installSkill.mockResolvedValue({ installed: ["code-reviewer"] });
    mockApi.listSkills.mockResolvedValue(createSkillsResponse());

    render(<SkillsPage />);
    await screen.findByText("feature-dev");

    // Expand the plugin
    fireEvent.click(screen.getByText("feature-dev"));
    await screen.findByText("code-reviewer");

    // The individual Install buttons appear for each installable item.
    // Items order: feature-dev (command), code-reviewer (agent).
    // We click the second one to install code-reviewer specifically.
    const installButtons = screen.getAllByText("Install");
    fireEvent.click(installButtons[1]); // code-reviewer's Install button

    // Wait for the portal scope menu to appear
    await waitFor(() => {
      expect(document.body.querySelector('[class*="z-[9999]"] button')).toBeTruthy();
    });

    // Click User-level (first button in portal)
    const scopeButtons = document.body.querySelector('[class*="z-[9999]"]')!.querySelectorAll("button");
    fireEvent.click(scopeButtons[0]);

    await screen.findByText('Installed "code-reviewer"');
    expect(mockApi.installSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginName: "feature-dev",
        skillName: "code-reviewer",
        scope: "user",
        cwd: "/test-project",
      }),
    );
  });

  it("shows error feedback when install fails", async () => {
    // Verifies error toast when the install API call fails
    mockApi.installSkill.mockRejectedValue(new Error('Skill "bad" not found in plugin "feature-dev"'));

    render(<SkillsPage />);
    await screen.findByText("feature-dev");

    fireEvent.click(screen.getByText("feature-dev"));
    await screen.findByText("code-reviewer");

    const installButtons = screen.getAllByText("Install");
    fireEvent.click(installButtons[0]);

    // Click User-level in portal
    await waitFor(() => {
      expect(document.body.querySelector('[class*="z-[9999]"] button')).toBeTruthy();
    });
    const scopeButtons = document.body.querySelector('[class*="z-[9999]"]')!.querySelectorAll("button");
    fireEvent.click(scopeButtons[0]);

    await screen.findByText('Skill "bad" not found in plugin "feature-dev"');
  });

  it("uninstalls a skill and shows success feedback", async () => {
    // Verifies the uninstall flow: click Remove > success toast > data reloaded
    mockApi.uninstallSkill.mockResolvedValue({ removed: true });

    render(<SkillsPage />);
    await screen.findByText("my-installed-skill");

    fireEvent.click(screen.getByText("Remove"));

    await screen.findByText('Removed "my-installed-skill"');
    expect(mockApi.uninstallSkill).toHaveBeenCalledWith({
      name: "my-installed-skill",
      scope: "user",
      cwd: "/test-project",
    });
  });

  it("navigates back when Back button is clicked", async () => {
    render(<SkillsPage />);
    await screen.findByText("Skills");

    fireEvent.click(screen.getByText("Back"));
    expect(window.location.hash).toBe("");
  });
});
