import { useState } from "react";

const TOOL_ICONS: Record<string, string> = {
  Bash: "terminal",
  Read: "file",
  Write: "file-plus",
  Edit: "file-edit",
  Glob: "search",
  Grep: "search",
  WebFetch: "globe",
  WebSearch: "globe",
  NotebookEdit: "file-edit",
  TaskCreate: "list",
  TaskUpdate: "list",
  SendMessage: "message",
  // Codex tool types (mapped by codex-adapter)
  web_search: "globe",
  mcp_tool_call: "tool",
};

export function getToolIcon(name: string): string {
  return TOOL_ICONS[name] || "tool";
}

export function getToolLabel(name: string): string {
  if (name === "Bash") return "Terminal";
  if (name === "Read") return "Read File";
  if (name === "Write") return "Write File";
  if (name === "Edit") return "Edit File";
  if (name === "Glob") return "Find Files";
  if (name === "Grep") return "Search Content";
  if (name === "web_search") return "Web Search";
  if (name === "mcp_tool_call") return "MCP Tool";
  // Codex MCP tools come as "mcp:server:tool"
  if (name.startsWith("mcp:")) return name.split(":").slice(1).join(":");
  return name;
}

export function ToolBlock({
  name,
  input,
  toolUseId,
}: {
  name: string;
  input: Record<string, unknown>;
  toolUseId: string;
}) {
  const [open, setOpen] = useState(false);
  const iconType = getToolIcon(name);
  const label = getToolLabel(name);

  // Extract the most useful preview
  const preview = getPreview(name, input);

  return (
    <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <ToolIcon type={iconType} />
        <span className="text-xs font-medium text-cc-fg">{label}</span>
        {preview && (
          <span className="text-xs text-cc-muted truncate flex-1 font-mono-code">
            {preview}
          </span>
        )}
      </button>

      {open && (
        <div className="px-3 pb-3 pt-0 border-t border-cc-border">
          <div className="mt-2">
            {name === "Bash" && typeof input.command === "string" ? (
              <pre className="px-3 py-2 rounded-lg bg-cc-code-bg text-cc-code-fg text-[12px] font-mono-code leading-relaxed overflow-x-auto">
                <span className="text-cc-muted select-none">$ </span>
                {input.command}
              </pre>
            ) : name === "Edit" ? (
              <EditToolDetail input={input} />
            ) : name === "Write" ? (
              <WriteToolDetail input={input} />
            ) : name === "Read" ? (
              <div className="text-xs text-cc-muted font-mono-code">
                {String(input.file_path || input.path || "")}
              </div>
            ) : (
              <pre className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
                {JSON.stringify(input, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EditToolDetail({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.file_path || "");
  const oldStr = String(input.old_string || "");
  const newStr = String(input.new_string || "");

  return (
    <div className="space-y-2">
      <div className="text-xs text-cc-muted font-mono-code">{filePath}</div>
      {oldStr && (
        <div className="rounded-lg overflow-hidden border border-cc-border">
          <div className="px-2 py-1 bg-cc-error/5 text-[10px] text-cc-error font-mono-code">removed</div>
          <pre className="px-3 py-2 bg-cc-code-bg text-cc-code-fg text-[11px] font-mono-code leading-relaxed overflow-x-auto max-h-32 overflow-y-auto">
            {oldStr}
          </pre>
        </div>
      )}
      {newStr && (
        <div className="rounded-lg overflow-hidden border border-cc-border">
          <div className="px-2 py-1 bg-cc-success/5 text-[10px] text-cc-success font-mono-code">added</div>
          <pre className="px-3 py-2 bg-cc-code-bg text-cc-code-fg text-[11px] font-mono-code leading-relaxed overflow-x-auto max-h-32 overflow-y-auto">
            {newStr}
          </pre>
        </div>
      )}
    </div>
  );
}

function WriteToolDetail({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.file_path || "");
  const content = String(input.content || "");
  const preview = content.length > 500 ? content.slice(0, 500) + "..." : content;

  return (
    <div className="space-y-2">
      <div className="text-xs text-cc-muted font-mono-code">{filePath}</div>
      <pre className="px-3 py-2 rounded-lg bg-cc-code-bg text-cc-code-fg text-[11px] font-mono-code leading-relaxed overflow-x-auto max-h-40 overflow-y-auto">
        {preview}
      </pre>
    </div>
  );
}

export function getPreview(name: string, input: Record<string, unknown>): string {
  if (name === "Bash" && typeof input.command === "string") {
    return input.command.length > 60 ? input.command.slice(0, 60) + "..." : input.command;
  }
  if ((name === "Read" || name === "Write" || name === "Edit") && input.file_path) {
    const path = String(input.file_path);
    return path.split("/").slice(-2).join("/");
  }
  if (name === "Glob" && input.pattern) return String(input.pattern);
  if (name === "Grep" && input.pattern) return String(input.pattern);
  if (name === "WebSearch" && input.query) return String(input.query);
  return "";
}

export function ToolIcon({ type }: { type: string }) {
  const cls = "w-3.5 h-3.5 text-cc-primary shrink-0";

  if (type === "terminal") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <polyline points="3 11 6 8 3 5" />
        <line x1="8" y1="11" x2="13" y2="11" />
      </svg>
    );
  }
  if (type === "file" || type === "file-plus" || type === "file-edit") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M9 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V5L9 1z" />
        <polyline points="9 1 9 5 13 5" />
      </svg>
    );
  }
  if (type === "search") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <circle cx="7" cy="7" r="4" />
        <path d="M13 13l-3-3" />
      </svg>
    );
  }
  if (type === "globe") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c2 2 3 4 3 6s-1 4-3 6c-2-2-3-4-3-6s1-4 3-6z" />
      </svg>
    );
  }
  if (type === "message") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M14 10a1 1 0 01-1 1H5l-3 3V3a1 1 0 011-1h10a1 1 0 011 1v7z" />
      </svg>
    );
  }
  if (type === "list") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M3 4h10M3 8h10M3 12h6" />
      </svg>
    );
  }
  // Default tool icon
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
      <path d="M10.5 2.5l3 3-8 8H2.5v-3l8-8z" />
    </svg>
  );
}
