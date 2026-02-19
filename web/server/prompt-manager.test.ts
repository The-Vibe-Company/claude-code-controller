import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let promptManager: typeof import("./prompt-manager.js");

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => {
      dir = d;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  };
});

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "prompt-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  promptManager = await import("./prompt-manager.js");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createPrompt", () => {
  it("creates a global prompt", () => {
    // Validates global prompts persist without project path coupling.
    const prompt = promptManager.createPrompt("Review PR", "Review this PR and summarize risks", "global");
    expect(prompt.scope).toBe("global");
    expect(prompt.projectPath).toBeUndefined();
    expect(prompt.id).toBeTruthy();
  });

  it("creates a project prompt with normalized path", () => {
    // Validates project scope stores a normalized project root for later cwd matching.
    const prompt = promptManager.createPrompt("Plan", "Plan this feature", "project", "/tmp/my-repo/");
    expect(prompt.scope).toBe("project");
    expect(prompt.projectPath).toBe("/tmp/my-repo");
  });

  it("rejects project prompts without a project path", () => {
    expect(() => promptManager.createPrompt("Plan", "x", "project")).toThrow(
      "Project path is required for project prompts",
    );
  });
});

describe("listPrompts", () => {
  it("returns global + matching project prompts for cwd", () => {
    // Verifies cwd filtering includes global prompts and only project prompts in the same repo subtree.
    const global = promptManager.createPrompt("Global", "Global text", "global");
    const project = promptManager.createPrompt("Project", "Project text", "project", "/tmp/repo");
    promptManager.createPrompt("Other", "Other text", "project", "/tmp/other");

    const prompts = promptManager.listPrompts({ cwd: "/tmp/repo/packages/ui" });
    expect(prompts.map((p) => p.id)).toContain(global.id);
    expect(prompts.map((p) => p.id)).toContain(project.id);
    expect(prompts.map((p) => p.name)).not.toContain("Other");
  });
});

describe("updatePrompt and deletePrompt", () => {
  it("updates a prompt name/content", () => {
    // Ensures edits update mutable fields while preserving prompt identity.
    const prompt = promptManager.createPrompt("Old", "Old content", "global");
    const updated = promptManager.updatePrompt(prompt.id, { name: "New", content: "New content" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("New");
    expect(updated!.content).toBe("New content");
  });

  it("deletes a prompt", () => {
    // Ensures a deleted prompt is no longer retrievable.
    const prompt = promptManager.createPrompt("Delete me", "tmp", "global");
    expect(promptManager.deletePrompt(prompt.id)).toBe(true);
    expect(promptManager.getPrompt(prompt.id)).toBeNull();
  });
});
