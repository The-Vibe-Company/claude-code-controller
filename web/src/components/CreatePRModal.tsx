import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";

interface CreatePRModalProps {
  cwd: string;
  branch: string;
  baseBranch: string;
  onClose: () => void;
  onSuccess: (prUrl: string, gitAhead: number, gitBehind: number) => void;
}

export function CreatePRModal({ cwd, branch, baseBranch, onClose, onSuccess }: CreatePRModalProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingCommits, setLoadingCommits] = useState(true);

  useEffect(() => {
    api.getCommitLog(cwd, baseBranch)
      .then((commits) => {
        if (commits.length === 1) {
          setTitle(commits[0].subject);
        } else if (commits.length > 1) {
          setTitle(commits[0].subject);
          setBody(commits.map((c) => `- ${c.subject}`).join("\n"));
        } else {
          setTitle(branch);
        }
      })
      .catch(() => {
        setTitle(branch);
      })
      .finally(() => setLoadingCommits(false));
  }, [cwd, baseBranch, branch]);

  async function handleCreate() {
    if (!title.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.createPR({
        cwd,
        branch,
        baseBranch,
        title: title.trim(),
        body: body.trim() || undefined,
        draft,
      });
      onSuccess(result.prUrl, result.git_ahead, result.git_behind);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[90dvh] sm:max-h-[80dvh] mx-0 sm:mx-4 flex flex-col bg-cc-bg border border-cc-border rounded-t-[14px] sm:rounded-[14px] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-cc-border">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-primary">
              <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
            </svg>
            <h2 className="text-sm font-semibold text-cc-fg">Create Pull Request</h2>
          </div>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-3 sm:py-4 space-y-3">
          {/* Branch info */}
          <div className="flex items-center gap-2 text-[11px] text-cc-muted">
            <span className="font-medium text-cc-fg">{branch}</span>
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
              <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            <span className="font-medium text-cc-fg">{baseBranch}</span>
          </div>

          {/* Error */}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
              {error}
            </div>
          )}

          {/* Title */}
          <div>
            <label className="block text-[11px] font-medium text-cc-muted mb-1">Title</label>
            <input
              type="text"
              value={loadingCommits ? "" : title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={loadingCommits ? "Loading..." : "PR title"}
              disabled={loadingCommits || loading}
              className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/40 disabled:opacity-50"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && title.trim()) {
                  e.preventDefault();
                  handleCreate();
                }
              }}
            />
          </div>

          {/* Body */}
          <div>
            <label className="block text-[11px] font-medium text-cc-muted mb-1">Description</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Optional description"
              disabled={loadingCommits || loading}
              rows={4}
              className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/40 resize-none disabled:opacity-50"
            />
          </div>

          {/* Draft checkbox */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
              disabled={loading}
              className="rounded border-cc-border text-cc-primary focus:ring-cc-primary/30"
            />
            <span className="text-xs text-cc-muted">Create as draft</span>
          </label>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 sm:px-5 py-3 border-t border-cc-border">
          <button
            onClick={onClose}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium text-cc-muted hover:text-cc-fg rounded-lg hover:bg-cc-hover transition-colors cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={loading || loadingCommits || !title.trim()}
            className="px-4 py-1.5 text-xs font-medium text-white bg-cc-primary hover:bg-cc-primary-hover rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {loading ? (
              <>
                <svg className="animate-spin w-3 h-3" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                  <path d="M14 8a6 6 0 01-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                Creating...
              </>
            ) : (
              "Create PR"
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
