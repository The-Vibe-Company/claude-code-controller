import { useState, useEffect } from "react";
import { PermissionBanner } from "./PermissionBanner.js";
import { MessageBubble } from "./MessageBubble.js";
import { ToolBlock, getToolIcon, getToolLabel, getPreview, ToolIcon } from "./ToolBlock.js";
import { DiffViewer } from "./DiffViewer.js";
import { UpdateBanner } from "./UpdateBanner.js";
import { ClaudeMdEditor } from "./ClaudeMdEditor.js";
import { ChatView } from "./ChatView.js";
import { useStore } from "../store.js";
import { api } from "../api.js";
import type { PermissionRequest, ChatMessage, ContentBlock, SessionState, McpServerDetail } from "../types.js";
import type { TaskItem } from "../types.js";
import type { UpdateInfo, GitHubPRInfo } from "../api.js";
import { GitHubPRDisplay } from "./TaskPanel.js";

// ─── Mock Data ──────────────────────────────────────────────────────────────

const MOCK_SESSION_ID = "playground-session";

function mockPermission(overrides: Partial<PermissionRequest> & { tool_name: string; input: Record<string, unknown> }): PermissionRequest {
  return {
    request_id: `perm-${Math.random().toString(36).slice(2, 8)}`,
    tool_use_id: `tu-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

const PERM_BASH = mockPermission({
  tool_name: "Bash",
  input: {
    command: "git log --oneline -20 && npm run build",
    description: "View recent commits and build the project",
  },
  permission_suggestions: [
    {
      type: "addRules" as const,
      rules: [{ toolName: "Bash", ruleContent: "git log --oneline -20 && npm run build" }],
      behavior: "allow" as const,
      destination: "session" as const,
    },
    {
      type: "addRules" as const,
      rules: [{ toolName: "Bash", ruleContent: "git log --oneline -20 && npm run build" }],
      behavior: "allow" as const,
      destination: "projectSettings" as const,
    },
  ],
});

const PERM_EDIT = mockPermission({
  tool_name: "Edit",
  input: {
    file_path: "/Users/stan/Dev/project/src/utils/format.ts",
    old_string: 'export function formatDate(d: Date) {\n  return d.toISOString();\n}',
    new_string: 'export function formatDate(d: Date, locale = "en-US") {\n  return d.toLocaleDateString(locale, {\n    year: "numeric",\n    month: "short",\n    day: "numeric",\n  });\n}',
  },
  permission_suggestions: [
    {
      type: "addRules" as const,
      rules: [{ toolName: "Edit" }],
      behavior: "allow" as const,
      destination: "session" as const,
    },
  ],
});

const PERM_WRITE = mockPermission({
  tool_name: "Write",
  input: {
    file_path: "/Users/stan/Dev/project/src/config.ts",
    content: 'export const config = {\n  apiUrl: "https://api.example.com",\n  timeout: 5000,\n  retries: 3,\n  debug: process.env.NODE_ENV !== "production",\n};\n',
  },
});

const PERM_READ = mockPermission({
  tool_name: "Read",
  input: { file_path: "/Users/stan/Dev/project/package.json" },
  permission_suggestions: [
    {
      type: "addRules" as const,
      rules: [{ toolName: "Read" }],
      behavior: "allow" as const,
      destination: "session" as const,
    },
    {
      type: "addRules" as const,
      rules: [{ toolName: "Read" }],
      behavior: "allow" as const,
      destination: "userSettings" as const,
    },
  ],
});

const PERM_GLOB = mockPermission({
  tool_name: "Glob",
  input: { pattern: "**/*.test.ts", path: "/Users/stan/Dev/project/src" },
});

const PERM_GREP = mockPermission({
  tool_name: "Grep",
  input: { pattern: "TODO|FIXME|HACK", path: "/Users/stan/Dev/project/src", glob: "*.ts" },
});

const PERM_EXIT_PLAN = mockPermission({
  tool_name: "ExitPlanMode",
  input: {
    plan: `## Summary\nRefactor the authentication module to use JWT tokens instead of session cookies.\n\n## Changes\n1. **Add JWT utility** — new \`src/auth/jwt.ts\` with sign/verify helpers\n2. **Update middleware** — modify \`src/middleware/auth.ts\` to validate Bearer tokens\n3. **Migrate login endpoint** — return JWT in response body instead of Set-Cookie\n4. **Update tests** — adapt all auth tests to use token-based flow\n\n## Test plan\n- Run \`npm test -- --grep auth\`\n- Manual test with curl`,
    allowedPrompts: [
      { tool: "Bash", prompt: "run tests" },
      { tool: "Bash", prompt: "install dependencies" },
    ],
  },
});

const PERM_GENERIC = mockPermission({
  tool_name: "WebSearch",
  input: { query: "TypeScript 5.5 new features", allowed_domains: ["typescriptlang.org", "github.com"] },
  description: "Search the web for TypeScript 5.5 features",
});

const PERM_DYNAMIC = mockPermission({
  tool_name: "dynamic:code_interpreter",
  input: { code: "print('hello from dynamic tool')" },
  description: "Custom tool call: code_interpreter",
});

const PERM_ASK_SINGLE = mockPermission({
  tool_name: "AskUserQuestion",
  input: {
    questions: [
      {
        header: "Auth method",
        question: "Which authentication method should we use for the API?",
        options: [
          { label: "JWT tokens (Recommended)", description: "Stateless, scalable, works well with microservices" },
          { label: "Session cookies", description: "Traditional approach, simpler but requires session storage" },
          { label: "OAuth 2.0", description: "Delegated auth, best for third-party integrations" },
        ],
        multiSelect: false,
      },
    ],
  },
});

const PERM_ASK_MULTI = mockPermission({
  tool_name: "AskUserQuestion",
  input: {
    questions: [
      {
        header: "Database",
        question: "Which database should we use?",
        options: [
          { label: "PostgreSQL", description: "Relational, strong consistency" },
          { label: "MongoDB", description: "Document store, flexible schema" },
        ],
        multiSelect: false,
      },
      {
        header: "Cache",
        question: "Do you want to add a caching layer?",
        options: [
          { label: "Redis", description: "In-memory, fast, supports pub/sub" },
          { label: "No cache", description: "Keep it simple for now" },
        ],
        multiSelect: false,
      },
    ],
  },
});

// Messages
const MSG_USER: ChatMessage = {
  id: "msg-1",
  role: "user",
  content: "Can you help me refactor the authentication module to use JWT tokens?",
  timestamp: Date.now() - 60000,
};

const MSG_USER_IMAGE: ChatMessage = {
  id: "msg-2",
  role: "user",
  content: "Here's a screenshot of the error I'm seeing",
  images: [
    {
      media_type: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==",
    },
  ],
  timestamp: Date.now() - 55000,
};

const MSG_ASSISTANT: ChatMessage = {
  id: "msg-3",
  role: "assistant",
  content: "",
  contentBlocks: [
    {
      type: "text",
      text: "I'll help you refactor the authentication module. Let me first look at the current implementation.\n\nHere's what I found:\n- The current auth uses **session cookies** via `express-session`\n- Sessions are stored in a `MemoryStore` (not production-ready)\n- The middleware checks `req.session.userId`\n\n```typescript\n// Current implementation\napp.use(session({\n  secret: process.env.SESSION_SECRET,\n  resave: false,\n  saveUninitialized: false,\n}));\n```\n\n| Feature | Cookies | JWT |\n|---------|---------|-----|\n| Stateless | No | Yes |\n| Scalable | Limited | Excellent |\n| Revocation | Easy | Needs blocklist |\n",
    },
  ],
  timestamp: Date.now() - 50000,
};

const MSG_ASSISTANT_TOOLS: ChatMessage = {
  id: "msg-4",
  role: "assistant",
  content: "",
  contentBlocks: [
    { type: "text", text: "Let me check the current auth files." },
    {
      type: "tool_use",
      id: "tu-1",
      name: "Glob",
      input: { pattern: "src/auth/**/*.ts" },
    },
    {
      type: "tool_result",
      tool_use_id: "tu-1",
      content: "src/auth/middleware.ts\nsrc/auth/login.ts\nsrc/auth/session.ts",
    },
    {
      type: "tool_use",
      id: "tu-2",
      name: "Read",
      input: { file_path: "src/auth/middleware.ts" },
    },
    {
      type: "tool_result",
      tool_use_id: "tu-2",
      content: 'export function authMiddleware(req, res, next) {\n  if (!req.session.userId) {\n    return res.status(401).json({ error: "Unauthorized" });\n  }\n  next();\n}',
    },
    { type: "text", text: "Now I understand the current structure. Let me create the JWT utility." },
  ],
  timestamp: Date.now() - 45000,
};

const MSG_ASSISTANT_THINKING: ChatMessage = {
  id: "msg-5",
  role: "assistant",
  content: "",
  contentBlocks: [
    {
      type: "thinking",
      thinking: "Let me think about the best approach here. The user wants to migrate from session cookies to JWT. I need to:\n1. Create a JWT sign/verify utility\n2. Update the middleware to read Authorization header\n3. Change the login endpoint to return a token\n4. Update all tests\n\nI should use jsonwebtoken package for signing and jose for verification in edge environments. But since this is a Node.js server, jsonwebtoken is fine.\n\nThe token should contain: userId, role, iat, exp. Expiry should be configurable. I'll also add a refresh token mechanism.",
    },
    { type: "text", text: "I've analyzed the codebase and have a clear plan. Let me start implementing." },
  ],
  timestamp: Date.now() - 40000,
};

const MSG_SYSTEM: ChatMessage = {
  id: "msg-6",
  role: "system",
  content: "Context compacted successfully",
  timestamp: Date.now() - 30000,
};

// Tool result with error
const MSG_TOOL_ERROR: ChatMessage = {
  id: "msg-7",
  role: "assistant",
  content: "",
  contentBlocks: [
    { type: "text", text: "Let me try running the tests." },
    {
      type: "tool_use",
      id: "tu-3",
      name: "Bash",
      input: { command: "npm test -- --grep auth" },
    },
    {
      type: "tool_result",
      tool_use_id: "tu-3",
      content: "FAIL src/auth/__tests__/middleware.test.ts\n  ● Auth Middleware › should reject expired tokens\n    Expected: 401\n    Received: 500\n\n    TypeError: Cannot read property 'verify' of undefined",
      is_error: true,
    },
    { type: "text", text: "There's a test failure. Let me fix the issue." },
  ],
  timestamp: Date.now() - 20000,
};

// Tasks
const MOCK_TASKS: TaskItem[] = [
  { id: "1", subject: "Create JWT utility module", description: "", status: "completed" },
  { id: "2", subject: "Update auth middleware", description: "", status: "completed", activeForm: "Updating auth middleware" },
  { id: "3", subject: "Migrate login endpoint", description: "", status: "in_progress", activeForm: "Refactoring login to return JWT" },
  { id: "4", subject: "Add refresh token support", description: "", status: "pending" },
  { id: "5", subject: "Update all auth tests", description: "", status: "pending", blockedBy: ["3"] },
  { id: "6", subject: "Run full test suite and fix failures", description: "", status: "pending", blockedBy: ["5"] },
];

// Tool group items (for ToolMessageGroup mock)
const MOCK_TOOL_GROUP_ITEMS = [
  { id: "tg-1", name: "Read", input: { file_path: "src/auth/middleware.ts" } },
  { id: "tg-2", name: "Read", input: { file_path: "src/auth/login.ts" } },
  { id: "tg-3", name: "Read", input: { file_path: "src/auth/session.ts" } },
  { id: "tg-4", name: "Read", input: { file_path: "src/auth/types.ts" } },
];

const MOCK_SUBAGENT_TOOL_ITEMS = [
  { id: "sa-1", name: "Grep", input: { pattern: "useAuth", path: "src/" } },
  { id: "sa-2", name: "Grep", input: { pattern: "session.userId", path: "src/" } },
];

// GitHub PR mock data
const MOCK_PR_FAILING: GitHubPRInfo = {
  number: 162,
  title: "feat: add dark mode toggle to application settings",
  url: "https://github.com/example/project/pull/162",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "CHANGES_REQUESTED",
  additions: 91,
  deletions: 88,
  changedFiles: 24,
  checks: [
    { name: "CI / Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "CI / Test", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "CI / Lint", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  checksSummary: { total: 3, success: 2, failure: 1, pending: 0 },
  reviewThreads: { total: 4, resolved: 2, unresolved: 2 },
};

const MOCK_PR_PASSING: GitHubPRInfo = {
  number: 158,
  title: "fix: prevent mobile keyboard layout shift and iOS zoom",
  url: "https://github.com/example/project/pull/158",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "APPROVED",
  additions: 42,
  deletions: 12,
  changedFiles: 3,
  checks: [
    { name: "CI / Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "CI / Test", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  checksSummary: { total: 2, success: 2, failure: 0, pending: 0 },
  reviewThreads: { total: 1, resolved: 1, unresolved: 0 },
};

const MOCK_PR_DRAFT: GitHubPRInfo = {
  number: 165,
  title: "refactor: migrate auth module to JWT tokens with refresh support",
  url: "https://github.com/example/project/pull/165",
  state: "OPEN",
  isDraft: true,
  reviewDecision: null,
  additions: 340,
  deletions: 156,
  changedFiles: 18,
  checks: [
    { name: "CI / Build", status: "IN_PROGRESS", conclusion: null },
    { name: "CI / Test", status: "QUEUED", conclusion: null },
  ],
  checksSummary: { total: 2, success: 0, failure: 0, pending: 2 },
  reviewThreads: { total: 0, resolved: 0, unresolved: 0 },
};

const MOCK_PR_MERGED: GitHubPRInfo = {
  number: 155,
  title: "feat(cli): add service install/uninstall and separate dev/prod ports",
  url: "https://github.com/example/project/pull/155",
  state: "MERGED",
  isDraft: false,
  reviewDecision: "APPROVED",
  additions: 287,
  deletions: 63,
  changedFiles: 11,
  checks: [
    { name: "CI / Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "CI / Test", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "CI / Lint", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  checksSummary: { total: 3, success: 3, failure: 0, pending: 0 },
  reviewThreads: { total: 3, resolved: 3, unresolved: 0 },
};

// MCP server mock data
const MOCK_MCP_SERVERS: McpServerDetail[] = [
  {
    name: "filesystem",
    status: "connected",
    config: { type: "stdio", command: "npx", args: ["-y", "@anthropic/mcp-fs"] },
    scope: "project",
    tools: [
      { name: "read_file", annotations: { readOnly: true } },
      { name: "write_file", annotations: { destructive: true } },
      { name: "list_directory", annotations: { readOnly: true } },
    ],
  },
  {
    name: "github",
    status: "connected",
    config: { type: "stdio", command: "npx", args: ["-y", "@anthropic/mcp-github"] },
    scope: "user",
    tools: [
      { name: "create_issue" },
      { name: "list_prs", annotations: { readOnly: true } },
      { name: "create_pr" },
    ],
  },
  {
    name: "postgres",
    status: "failed",
    error: "Connection refused: ECONNREFUSED 127.0.0.1:5432",
    config: { type: "stdio", command: "npx", args: ["-y", "@anthropic/mcp-postgres"] },
    scope: "project",
    tools: [],
  },
  {
    name: "web-search",
    status: "disabled",
    config: { type: "sse", url: "http://localhost:8080/sse" },
    scope: "user",
    tools: [{ name: "search", annotations: { readOnly: true, openWorld: true } }],
  },
  {
    name: "docker",
    status: "connecting",
    config: { type: "stdio", command: "docker-mcp-server" },
    scope: "project",
    tools: [],
  },
];

// ─── Playground Component ───────────────────────────────────────────────────

export function Playground() {
  const [darkMode, setDarkMode] = useState(
    () => document.documentElement.classList.contains("dark")
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  useEffect(() => {
    const store = useStore.getState();
    const snapshot = useStore.getState();
    const sessionId = MOCK_SESSION_ID;

    const prevSession = snapshot.sessions.get(sessionId);
    const prevMessages = snapshot.messages.get(sessionId);
    const prevPerms = snapshot.pendingPermissions.get(sessionId);
    const prevConn = snapshot.connectionStatus.get(sessionId);
    const prevCli = snapshot.cliConnected.get(sessionId);
    const prevStatus = snapshot.sessionStatus.get(sessionId);
    const prevStreaming = snapshot.streaming.get(sessionId);
    const prevStreamingStartedAt = snapshot.streamingStartedAt.get(sessionId);
    const prevStreamingOutputTokens = snapshot.streamingOutputTokens.get(sessionId);

    const session: SessionState = {
      session_id: sessionId,
      backend_type: "claude",
      model: "claude-sonnet-4-5",
      cwd: "/Users/stan/Dev/project",
      tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebSearch"],
      permissionMode: "default",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: ["explain", "review", "fix"],
      skills: ["doc-coauthoring", "frontend-design"],
      total_cost_usd: 0.1847,
      num_turns: 14,
      context_used_percent: 62,
      is_compacting: false,
      git_branch: "feat/jwt-auth",
      is_worktree: true,
      repo_root: "/Users/stan/Dev/project",
      git_ahead: 3,
      git_behind: 0,
      total_lines_added: 142,
      total_lines_removed: 38,
    };

    store.addSession(session);
    store.setConnectionStatus(sessionId, "connected");
    store.setCliConnected(sessionId, true);
    store.setSessionStatus(sessionId, "running");
    store.setMessages(sessionId, [
      MSG_USER,
      MSG_ASSISTANT,
      MSG_ASSISTANT_TOOLS,
      MSG_TOOL_ERROR,
    ]);
    store.setStreaming(sessionId, "I'm updating tests and then I'll run the full suite.");
    store.setStreamingStats(sessionId, { startedAt: Date.now() - 12000, outputTokens: 1200 });
    store.addPermission(sessionId, PERM_BASH);
    store.addPermission(sessionId, PERM_DYNAMIC);

    return () => {
      useStore.setState((s) => {
        const sessions = new Map(s.sessions);
        const messages = new Map(s.messages);
        const pendingPermissions = new Map(s.pendingPermissions);
        const connectionStatus = new Map(s.connectionStatus);
        const cliConnected = new Map(s.cliConnected);
        const sessionStatus = new Map(s.sessionStatus);
        const streaming = new Map(s.streaming);
        const streamingStartedAt = new Map(s.streamingStartedAt);
        const streamingOutputTokens = new Map(s.streamingOutputTokens);

        if (prevSession) sessions.set(sessionId, prevSession); else sessions.delete(sessionId);
        if (prevMessages) messages.set(sessionId, prevMessages); else messages.delete(sessionId);
        if (prevPerms) pendingPermissions.set(sessionId, prevPerms); else pendingPermissions.delete(sessionId);
        if (prevConn) connectionStatus.set(sessionId, prevConn); else connectionStatus.delete(sessionId);
        if (typeof prevCli === "boolean") cliConnected.set(sessionId, prevCli); else cliConnected.delete(sessionId);
        if (prevStatus) sessionStatus.set(sessionId, prevStatus); else sessionStatus.delete(sessionId);
        if (typeof prevStreaming === "string") streaming.set(sessionId, prevStreaming); else streaming.delete(sessionId);
        if (typeof prevStreamingStartedAt === "number") streamingStartedAt.set(sessionId, prevStreamingStartedAt); else streamingStartedAt.delete(sessionId);
        if (typeof prevStreamingOutputTokens === "number") streamingOutputTokens.set(sessionId, prevStreamingOutputTokens); else streamingOutputTokens.delete(sessionId);

        return {
          sessions,
          messages,
          pendingPermissions,
          connectionStatus,
          cliConnected,
          sessionStatus,
          streaming,
          streamingStartedAt,
          streamingOutputTokens,
        };
      });
    };
  }, []);

  return (
    <div className="min-h-screen bg-cc-bg text-cc-fg font-sans-ui">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-cc-sidebar border-b border-cc-border">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-cc-fg tracking-tight">Component Playground</h1>
            <p className="text-xs text-cc-muted mt-0.5">Visual catalog of all UI components</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => { window.location.hash = ""; }}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg border border-cc-border transition-colors cursor-pointer"
            >
              Back to App
            </button>
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary/10 hover:bg-cc-primary/20 text-cc-primary border border-cc-primary/20 transition-colors cursor-pointer"
            >
              {darkMode ? "Light Mode" : "Dark Mode"}
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-12">
        {/* ─── Permission Banners ──────────────────────────────── */}
        <Section title="Permission Banners" description="Tool approval requests shown above the composer">
          <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card divide-y divide-cc-border">
            <PermissionBanner permission={PERM_BASH} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_EDIT} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_WRITE} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_READ} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_GLOB} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_GREP} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_GENERIC} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_DYNAMIC} sessionId={MOCK_SESSION_ID} />
          </div>
        </Section>

        {/* ─── Real Chat Stack ──────────────────────────────── */}
        <Section title="Real Chat Stack" description="Integrated ChatView using real MessageFeed + PermissionBanner + Composer components">
          <div data-testid="playground-real-chat-stack" className="max-w-3xl border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[620px]">
            <ChatView sessionId={MOCK_SESSION_ID} />
          </div>
        </Section>

        {/* ─── ExitPlanMode (the fix) ──────────────────────────── */}
        <Section title="ExitPlanMode" description="Plan approval request — previously rendered as raw JSON, now shows formatted markdown">
          <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card">
            <PermissionBanner permission={PERM_EXIT_PLAN} sessionId={MOCK_SESSION_ID} />
          </div>
        </Section>

        {/* ─── AskUserQuestion ──────────────────────────────── */}
        <Section title="AskUserQuestion" description="Interactive questions with selectable options">
          <div className="space-y-4">
            <Card label="Single question">
              <PermissionBanner permission={PERM_ASK_SINGLE} sessionId={MOCK_SESSION_ID} />
            </Card>
            <Card label="Multi-question">
              <PermissionBanner permission={PERM_ASK_MULTI} sessionId={MOCK_SESSION_ID} />
            </Card>
          </div>
        </Section>

        {/* ─── Messages ──────────────────────────────── */}
        <Section title="Messages" description="Chat message bubbles for all roles">
          <div className="space-y-4 max-w-3xl">
            <Card label="User message">
              <MessageBubble message={MSG_USER} />
            </Card>
            <Card label="User message with image">
              <MessageBubble message={MSG_USER_IMAGE} />
            </Card>
            <Card label="Assistant message (markdown)">
              <MessageBubble message={MSG_ASSISTANT} />
            </Card>
            <Card label="Assistant message (with tool calls)">
              <MessageBubble message={MSG_ASSISTANT_TOOLS} />
            </Card>
            <Card label="Assistant message (thinking block)">
              <MessageBubble message={MSG_ASSISTANT_THINKING} />
            </Card>
            <Card label="Tool result with error">
              <MessageBubble message={MSG_TOOL_ERROR} />
            </Card>
            <Card label="System message">
              <MessageBubble message={MSG_SYSTEM} />
            </Card>
          </div>
        </Section>

        {/* ─── Tool Blocks (standalone) ──────────────────────── */}
        <Section title="Tool Blocks" description="Expandable tool call visualization">
          <div className="space-y-2 max-w-3xl">
            <ToolBlock name="Bash" input={{ command: "git status && npm run lint" }} toolUseId="tb-1" />
            <ToolBlock name="Read" input={{ file_path: "/Users/stan/Dev/project/src/index.ts" }} toolUseId="tb-2" />
            <ToolBlock name="Edit" input={{ file_path: "src/utils.ts", old_string: "const x = 1;", new_string: "const x = 2;" }} toolUseId="tb-3" />
            <ToolBlock name="Write" input={{ file_path: "src/new-file.ts", content: 'export const hello = "world";\n' }} toolUseId="tb-4" />
            <ToolBlock name="Glob" input={{ pattern: "**/*.tsx" }} toolUseId="tb-5" />
            <ToolBlock name="Grep" input={{ pattern: "useEffect", path: "src/", glob: "*.tsx" }} toolUseId="tb-6" />
            <ToolBlock name="WebSearch" input={{ query: "React 19 new features" }} toolUseId="tb-7" />
          </div>
        </Section>

        {/* ─── Task Panel ──────────────────────────────── */}
        <Section title="Tasks" description="Task list states: pending, in progress, completed, blocked">
          <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
            {/* Session stats mock */}
            <div className="px-4 py-3 border-b border-cc-border space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-cc-muted uppercase tracking-wider">Cost</span>
                <span className="text-[13px] font-medium text-cc-fg tabular-nums">$0.1847</span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-cc-muted uppercase tracking-wider">Context</span>
                  <span className="text-[11px] text-cc-muted tabular-nums">62%</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
                  <div className="h-full rounded-full bg-cc-warning transition-all duration-500" style={{ width: "62%" }} />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-cc-muted uppercase tracking-wider">Turns</span>
                <span className="text-[13px] font-medium text-cc-fg tabular-nums">14</span>
              </div>
            </div>
            {/* Task header */}
            <div className="px-4 py-2.5 border-b border-cc-border flex items-center justify-between">
              <span className="text-[12px] font-semibold text-cc-fg">Tasks</span>
              <span className="text-[11px] text-cc-muted tabular-nums">2/{MOCK_TASKS.length}</span>
            </div>
            {/* Task list */}
            <div className="px-3 py-2 space-y-0.5">
              {MOCK_TASKS.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </div>
          </div>
        </Section>

        {/* ─── GitHub PR Status ──────────────────────────────── */}
        <Section title="GitHub PR Status" description="PR health shown in the TaskPanel — checks, reviews, unresolved comments">
          <div className="space-y-4">
            <Card label="Open PR — failing checks + changes requested">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <GitHubPRDisplay pr={MOCK_PR_FAILING} />
              </div>
            </Card>
            <Card label="Open PR — all checks passed + approved">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <GitHubPRDisplay pr={MOCK_PR_PASSING} />
              </div>
            </Card>
            <Card label="Draft PR — pending checks">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <GitHubPRDisplay pr={MOCK_PR_DRAFT} />
              </div>
            </Card>
            <Card label="Merged PR">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <GitHubPRDisplay pr={MOCK_PR_MERGED} />
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── MCP Servers ──────────────────────────────── */}
        <Section title="MCP Servers" description="MCP server status display with toggle, reconnect, and tool listing">
          <div className="space-y-4">
            <Card label="All server states (connected, failed, disabled, connecting)">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                {/* MCP section header */}
                <div className="shrink-0 px-4 py-2.5 border-b border-cc-border flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-cc-fg flex items-center gap-1.5">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted">
                      <path d="M1.5 3A1.5 1.5 0 013 1.5h10A1.5 1.5 0 0114.5 3v1A1.5 1.5 0 0113 5.5H3A1.5 1.5 0 011.5 4V3zm0 5A1.5 1.5 0 013 6.5h10A1.5 1.5 0 0114.5 8v1A1.5 1.5 0 0113 10.5H3A1.5 1.5 0 011.5 9V8zm0 5A1.5 1.5 0 013 11.5h10a1.5 1.5 0 011.5 1.5v1a1.5 1.5 0 01-1.5 1.5H3A1.5 1.5 0 011.5 14v-1z" />
                    </svg>
                    MCP Servers
                  </span>
                  <span className="text-[11px] text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                      <path d="M2.5 8a5.5 5.5 0 019.78-3.5M13.5 8a5.5 5.5 0 01-9.78 3.5" strokeLinecap="round" />
                      <path d="M12.5 2v3h-3M3.5 14v-3h3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </div>
                {/* Server rows */}
                <div className="px-3 py-2 space-y-1.5">
                  {MOCK_MCP_SERVERS.map((server) => (
                    <PlaygroundMcpRow key={server.name} server={server} />
                  ))}
                </div>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Update Banner ──────────────────────────────── */}
        <Section title="Update Banner" description="Notification banner for available updates">
          <div className="space-y-4 max-w-3xl">
            <Card label="Service mode (auto-update)">
              <PlaygroundUpdateBanner
                updateInfo={{
                  currentVersion: "0.22.1",
                  latestVersion: "0.23.0",
                  updateAvailable: true,
                  isServiceMode: true,
                  updateInProgress: false,
                  lastChecked: Date.now(),
                }}
              />
            </Card>
            <Card label="Foreground mode (manual)">
              <PlaygroundUpdateBanner
                updateInfo={{
                  currentVersion: "0.22.1",
                  latestVersion: "0.23.0",
                  updateAvailable: true,
                  isServiceMode: false,
                  updateInProgress: false,
                  lastChecked: Date.now(),
                }}
              />
            </Card>
            <Card label="Update in progress">
              <PlaygroundUpdateBanner
                updateInfo={{
                  currentVersion: "0.22.1",
                  latestVersion: "0.23.0",
                  updateAvailable: true,
                  isServiceMode: true,
                  updateInProgress: true,
                  lastChecked: Date.now(),
                }}
              />
            </Card>
          </div>
        </Section>

        {/* ─── Status Indicators ──────────────────────────────── */}
        <Section title="Status Indicators" description="Connection and session status banners">
          <div className="space-y-3 max-w-3xl">
            <Card label="Disconnected warning">
              <div className="px-4 py-2 bg-cc-warning/10 border border-cc-warning/20 rounded-lg text-center">
                <span className="text-xs text-cc-warning font-medium">Reconnecting to session...</span>
              </div>
            </Card>
            <Card label="Connected">
              <div className="flex items-center gap-2 px-3 py-2 bg-cc-card border border-cc-border rounded-lg">
                <span className="w-2 h-2 rounded-full bg-cc-success" />
                <span className="text-xs text-cc-fg font-medium">Connected</span>
                <span className="text-[11px] text-cc-muted ml-auto">claude-opus-4-6</span>
              </div>
            </Card>
            <Card label="Running / Thinking">
              <div className="flex items-center gap-2 px-3 py-2 bg-cc-card border border-cc-border rounded-lg">
                <span className="w-2 h-2 rounded-full bg-cc-primary animate-[pulse-dot_1.5s_ease-in-out_infinite]" />
                <span className="text-xs text-cc-fg font-medium">Thinking</span>
              </div>
            </Card>
            <Card label="Compacting">
              <div className="flex items-center gap-2 px-3 py-2 bg-cc-card border border-cc-border rounded-lg">
                <svg className="w-3.5 h-3.5 text-cc-muted animate-spin" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
                </svg>
                <span className="text-xs text-cc-muted font-medium">Compacting context...</span>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Composer ──────────────────────────────── */}
        <Section title="Composer" description="Message input bar with mode toggle, image upload, and send/stop buttons">
          <div className="max-w-3xl">
            <Card label="Connected — code mode">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  <textarea
                    readOnly
                    value="Can you refactor the auth module to use JWT?"
                    rows={1}
                    className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M2.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                        <path d="M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                          <path d="M3 2l11 6-11 6V9.5l7-1.5-7-1.5V2z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Plan mode active">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-primary/40 rounded-[14px] overflow-hidden">
                  <textarea
                    readOnly
                    value=""
                    placeholder="Type a message... (/ for commands)"
                    rows={1}
                    className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-primary">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <rect x="3" y="3" width="3.5" height="10" rx="0.75" />
                        <rect x="9.5" y="3" width="3.5" height="10" rx="0.75" />
                      </svg>
                      <span>plan</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                          <path d="M3 2l11 6-11 6V9.5l7-1.5-7-1.5V2z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Running — stop button visible">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  <textarea
                    readOnly
                    value=""
                    placeholder="Type a message... (/ for commands)"
                    rows={1}
                    className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                    style={{ minHeight: "36px" }}
                  />
                  {/* Git branch info */}
                  <div className="flex items-center gap-2 px-4 pb-1 text-[11px] text-cc-muted overflow-hidden">
                    <span className="flex items-center gap-1 truncate min-w-0">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-60">
                        <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                      </svg>
                      <span className="truncate">feat/jwt-auth</span>
                      <span className="text-[10px] bg-cc-primary/10 text-cc-primary px-1 rounded">worktree</span>
                    </span>
                    <span className="flex items-center gap-0.5 text-[10px]">
                      <span className="text-green-500">3&#8593;</span>
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      <span className="text-green-500">+142</span>
                      <span className="text-red-400">-38</span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M2.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                        <path d="M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-cc-error/10 text-cc-error">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                          <rect x="3" y="3" width="10" height="10" rx="1" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Streaming Indicator ──────────────────────────────── */}
        <Section title="Streaming Indicator" description="Live typing animation shown while the assistant is generating">
          <div className="space-y-4 max-w-3xl">
            <Card label="Streaming with cursor">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-cc-primary">
                    <path d="M8 1v14M1 8h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <pre className="font-serif-assistant text-[15px] text-cc-fg whitespace-pre-wrap break-words leading-relaxed">
                    I'll start by creating the JWT utility module with sign and verify helpers. Let me first check what dependencies are already installed...
                    <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                  </pre>
                </div>
              </div>
            </Card>
            <Card label="Generation stats bar">
              <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-cc-primary animate-pulse" />
                <span>Generating...</span>
                <span className="text-cc-muted/60">(</span>
                <span>12s</span>
                <span className="text-cc-muted/40">&middot;</span>
                <span>&darr; 1.2k</span>
                <span className="text-cc-muted/60">)</span>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Tool Message Groups ──────────────────────────────── */}
        <Section title="Tool Message Groups" description="Consecutive same-tool calls collapsed into a single expandable row">
          <div className="space-y-4 max-w-3xl">
            <Card label="Multi-item group (4 Reads)">
              <PlaygroundToolGroup toolName="Read" items={MOCK_TOOL_GROUP_ITEMS} />
            </Card>
            <Card label="Single-item group">
              <PlaygroundToolGroup toolName="Glob" items={[{ id: "sg-1", name: "Glob", input: { pattern: "src/auth/**/*.ts" } }]} />
            </Card>
          </div>
        </Section>

        {/* ─── Subagent Groups ──────────────────────────────── */}
        <Section title="Subagent Groups" description="Nested messages from Task tool subagents shown in a collapsible indent">
          <div className="space-y-4 max-w-3xl">
            <Card label="Subagent with nested tool calls">
              <PlaygroundSubagentGroup
                description="Search codebase for auth patterns"
                agentType="Explore"
                items={MOCK_SUBAGENT_TOOL_ITEMS}
              />
            </Card>
          </div>
        </Section>

        {/* ─── Diff Viewer ──────────────────────────────── */}
        <Section title="Diff Viewer" description="Unified diff rendering with word-level highlighting — used in ToolBlock, PermissionBanner, and DiffPanel">
          <div className="space-y-4 max-w-3xl">
            <Card label="Edit diff (compact mode)">
              <DiffViewer
                oldText={'export function formatDate(d: Date) {\n  return d.toISOString();\n}'}
                newText={'export function formatDate(d: Date, locale = "en-US") {\n  return d.toLocaleDateString(locale, {\n    year: "numeric",\n    month: "short",\n    day: "numeric",\n  });\n}'}
                fileName="src/utils/format.ts"
                mode="compact"
              />
            </Card>
            <Card label="New file diff (compact mode)">
              <DiffViewer
                newText={'export const config = {\n  apiUrl: "https://api.example.com",\n  timeout: 5000,\n  retries: 3,\n  debug: process.env.NODE_ENV !== "production",\n};\n'}
                fileName="src/config.ts"
                mode="compact"
              />
            </Card>
            <Card label="Git diff (full mode with line numbers)">
              <DiffViewer
                unifiedDiff={`diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts
--- a/src/auth/middleware.ts
+++ b/src/auth/middleware.ts
@@ -1,8 +1,12 @@
-import { getSession } from "./session";
+import { verifyToken } from "./jwt";
+import type { Request, Response, NextFunction } from "express";

-export function authMiddleware(req, res, next) {
-  const session = getSession(req);
-  if (!session?.userId) {
+export function authMiddleware(req: Request, res: Response, next: NextFunction) {
+  const header = req.headers.authorization;
+  if (!header?.startsWith("Bearer ")) {
     return res.status(401).json({ error: "Unauthorized" });
   }
-  req.userId = session.userId;
+  const token = header.slice(7);
+  const payload = verifyToken(token);
+  if (!payload) return res.status(401).json({ error: "Invalid token" });
+  req.userId = payload.userId;
   next();
 }`}
                mode="full"
              />
            </Card>
            <Card label="No changes">
              <DiffViewer oldText="same content" newText="same content" />
            </Card>
          </div>
        </Section>
        {/* ─── CLAUDE.md Editor ──────────────────────────────── */}
        <Section title="CLAUDE.md Editor" description="Modal for viewing and editing project CLAUDE.md instructions">
          <div className="space-y-4 max-w-3xl">
            <Card label="Open editor button (from TopBar)">
              <PlaygroundClaudeMdButton />
            </Card>
          </div>
        </Section>
      </div>
    </div>
  );
}

// ─── Shared Layout Helpers ──────────────────────────────────────────────────

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-4">
        <h2 className="text-base font-semibold text-cc-fg">{title}</h2>
        <p className="text-xs text-cc-muted mt-0.5">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card">
      <div className="px-3 py-1.5 bg-cc-hover/50 border-b border-cc-border">
        <span className="text-[10px] text-cc-muted font-mono-code uppercase tracking-wider">{label}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ─── Inline Tool Group (mirrors MessageFeed's ToolMessageGroup) ─────────────

interface ToolItem { id: string; name: string; input: Record<string, unknown> }

function PlaygroundToolGroup({ toolName, items }: { toolName: string; items: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const iconType = getToolIcon(toolName);
  const label = getToolLabel(toolName);
  const count = items.length;

  if (count === 1) {
    const item = items[0];
    return (
      <div className="flex items-start gap-3">
        <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-primary"><circle cx="8" cy="8" r="3" /></svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
            <button
              onClick={() => setOpen(!open)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}>
                <path d="M6 4l4 4-4 4" />
              </svg>
              <ToolIcon type={iconType} />
              <span className="text-xs font-medium text-cc-fg">{label}</span>
              <span className="text-xs text-cc-muted truncate flex-1 font-mono-code">
                {getPreview(item.name, item.input)}
              </span>
            </button>
            {open && (
              <div className="px-3 pb-3 pt-0 border-t border-cc-border mt-0">
                <pre className="mt-2 text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
                  {JSON.stringify(item.input, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-primary"><circle cx="8" cy="8" r="3" /></svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
          <button
            onClick={() => setOpen(!open)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}>
              <path d="M6 4l4 4-4 4" />
            </svg>
            <ToolIcon type={iconType} />
            <span className="text-xs font-medium text-cc-fg">{label}</span>
            <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums font-medium">
              {count}
            </span>
          </button>
          {open && (
            <div className="border-t border-cc-border px-3 py-1.5">
              {items.map((item, i) => {
                const preview = getPreview(item.name, item.input);
                return (
                  <div key={item.id || i} className="flex items-center gap-2 py-1 text-xs text-cc-muted font-mono-code truncate">
                    <span className="w-1 h-1 rounded-full bg-cc-muted/40 shrink-0" />
                    <span className="truncate">{preview || JSON.stringify(item.input).slice(0, 80)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Inline Subagent Group (mirrors MessageFeed's SubagentContainer) ────────

function PlaygroundSubagentGroup({ description, agentType, items }: { description: string; agentType: string; items: ToolItem[] }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="ml-9 border-l-2 border-cc-primary/20 pl-4">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 py-1.5 text-left cursor-pointer mb-1"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}>
          <path d="M6 4l4 4-4 4" />
        </svg>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 text-cc-primary shrink-0">
          <circle cx="8" cy="8" r="5" />
          <path d="M8 5v3l2 1" strokeLinecap="round" />
        </svg>
        <span className="text-xs font-medium text-cc-fg truncate">{description}</span>
        {agentType && (
          <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 shrink-0">
            {agentType}
          </span>
        )}
        <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums shrink-0 ml-auto">
          {items.length}
        </span>
      </button>
      {open && (
        <div className="space-y-3 pb-2">
          <PlaygroundToolGroup toolName={items[0]?.name || "Grep"} items={items} />
        </div>
      )}
    </div>
  );
}

// ─── Inline UpdateBanner (sets store state for playground preview) ───────────

function PlaygroundUpdateBanner({ updateInfo }: { updateInfo: UpdateInfo }) {
  useEffect(() => {
    const prev = useStore.getState().updateInfo;
    const prevDismissed = useStore.getState().updateDismissedVersion;
    useStore.getState().setUpdateInfo(updateInfo);
    // Clear any dismiss so the banner shows
    if (prevDismissed) {
      useStore.setState({ updateDismissedVersion: null });
    }
    return () => {
      useStore.getState().setUpdateInfo(prev);
      if (prevDismissed) {
        useStore.setState({ updateDismissedVersion: prevDismissed });
      }
    };
  }, [updateInfo]);

  return <UpdateBanner />;
}

// ─── Inline ClaudeMd Button (opens the real editor modal) ───────────────────

function PlaygroundClaudeMdButton() {
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState("/tmp");

  useEffect(() => {
    api.getHome().then((res) => setCwd(res.cwd)).catch(() => {});
  }, []);

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cc-hover border border-cc-border hover:bg-cc-active transition-colors cursor-pointer"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-primary">
          <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1zM6.5 7a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
        </svg>
        <span className="text-xs font-medium text-cc-fg">Edit CLAUDE.md</span>
      </button>
      <span className="text-[11px] text-cc-muted">
        Click to open the editor modal (uses server working directory)
      </span>
      <ClaudeMdEditor
        cwd={cwd}
        open={open}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

// ─── Inline MCP Server Row (static preview, no WebSocket) ──────────────────

function PlaygroundMcpRow({ server }: { server: McpServerDetail }) {
  const [expanded, setExpanded] = useState(false);
  const statusMap: Record<string, { label: string; cls: string; dot: string }> = {
    connected: { label: "Connected", cls: "text-cc-success bg-cc-success/10", dot: "bg-cc-success" },
    connecting: { label: "Connecting", cls: "text-cc-warning bg-cc-warning/10", dot: "bg-cc-warning animate-pulse" },
    failed: { label: "Failed", cls: "text-cc-error bg-cc-error/10", dot: "bg-cc-error" },
    disabled: { label: "Disabled", cls: "text-cc-muted bg-cc-hover", dot: "bg-cc-muted opacity-40" },
  };
  const badge = statusMap[server.status] || statusMap.disabled;

  return (
    <div className="rounded-lg border border-cc-border bg-cc-bg">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${badge.dot}`} />
        <button onClick={() => setExpanded(!expanded)} className="flex-1 min-w-0 text-left cursor-pointer">
          <span className="text-[12px] font-medium text-cc-fg truncate block">{server.name}</span>
        </button>
        <span className={`text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-1.5 border-t border-cc-border pt-2">
          <div className="text-[11px] text-cc-muted space-y-0.5">
            <div className="flex items-center gap-1">
              <span className="text-cc-muted/60">Type:</span>
              <span>{server.config.type}</span>
            </div>
            {server.config.command && (
              <div className="flex items-start gap-1">
                <span className="text-cc-muted/60 shrink-0">Cmd:</span>
                <span className="font-mono text-[10px] break-all">
                  {server.config.command}{server.config.args?.length ? ` ${server.config.args.join(" ")}` : ""}
                </span>
              </div>
            )}
            {server.config.url && (
              <div className="flex items-start gap-1">
                <span className="text-cc-muted/60 shrink-0">URL:</span>
                <span className="font-mono text-[10px] break-all">{server.config.url}</span>
              </div>
            )}
            <div className="flex items-center gap-1">
              <span className="text-cc-muted/60">Scope:</span>
              <span>{server.scope}</span>
            </div>
          </div>
          {server.error && (
            <div className="text-[11px] text-cc-error bg-cc-error/5 rounded px-2 py-1">{server.error}</div>
          )}
          {server.tools && server.tools.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] text-cc-muted uppercase tracking-wider">Tools ({server.tools.length})</span>
              <div className="flex flex-wrap gap-1">
                {server.tools.map((tool) => (
                  <span key={tool.name} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cc-hover text-cc-fg">
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Inline TaskRow (avoids store dependency from TaskPanel) ────────────────

function TaskRow({ task }: { task: TaskItem }) {
  const isCompleted = task.status === "completed";
  const isInProgress = task.status === "in_progress";

  return (
    <div className={`px-2.5 py-2 rounded-lg ${isCompleted ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-2">
        <span className="shrink-0 flex items-center justify-center w-4 h-4 mt-px">
          {isInProgress ? (
            <svg className="w-4 h-4 text-cc-primary animate-spin" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
            </svg>
          ) : isCompleted ? (
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-success">
              <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" className="w-4 h-4 text-cc-muted">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
        </span>
        <span className={`text-[13px] leading-snug flex-1 ${isCompleted ? "text-cc-muted line-through" : "text-cc-fg"}`}>
          {task.subject}
        </span>
      </div>
      {isInProgress && task.activeForm && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted italic truncate">{task.activeForm}</p>
      )}
      {task.blockedBy && task.blockedBy.length > 0 && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted flex items-center gap-1">
          <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 shrink-0">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span>blocked by {task.blockedBy.map((b) => `#${b}`).join(", ")}</span>
        </p>
      )}
    </div>
  );
}
