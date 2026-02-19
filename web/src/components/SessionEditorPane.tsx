import { useEffect, useState } from "react";
import { api, type EditorStartResult } from "../api.js";

interface SessionEditorPaneProps {
  sessionId: string;
}

export function SessionEditorPane({ sessionId }: SessionEditorPaneProps) {
  const [state, setState] = useState<EditorStartResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setState(null);

    api.startEditor(sessionId)
      .then((res) => {
        if (cancelled) return;
        setState(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          available: false,
          installed: false,
          mode: "host",
          message: err instanceof Error ? err.message : "Failed to start VS Code editor",
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center p-4 text-sm text-cc-muted">
        Starting VS Code editor...
      </div>
    );
  }

  if (!state?.available || !state.url) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-sm rounded-xl border border-cc-border bg-cc-bg p-4">
          <h3 className="text-sm font-semibold text-cc-fg">VS Code editor unavailable</h3>
          <p className="mt-2 text-xs text-cc-muted">
            {state?.message || "VS Code editor could not be started for this session."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-cc-bg">
      <div className="px-3 py-2 border-b border-cc-border bg-cc-sidebar flex items-center justify-between gap-2">
        <span className="text-xs text-cc-muted font-medium">VS Code</span>
        <a
          href={state.url}
          target="_blank"
          rel="noreferrer"
          className="px-2 py-1 rounded-md text-[11px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors"
        >
          Open in new tab
        </a>
      </div>
      <iframe
        title="VS Code editor"
        src={state.url}
        className="flex-1 min-h-0 w-full border-0 bg-cc-bg"
      />
    </div>
  );
}
