import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type SavedPrompt } from "../api.js";
import { useStore } from "../store.js";
import { navigateHome, navigateToSession } from "../utils/routing.js";

interface PromptsPageProps {
  embedded?: boolean;
}

export function PromptsPage({ embedded = false }: PromptsPageProps) {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [search, setSearch] = useState("");

  const currentSessionId = useStore((s) => s.currentSessionId);
  const cwd = useStore((s) => {
    if (!s.currentSessionId) return "";
    return s.sessions.get(s.currentSessionId)?.cwd
      || s.sdkSessions.find((sdk) => sdk.sessionId === s.currentSessionId)?.cwd
      || "";
  });

  const filteredPrompts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return prompts;
    return prompts.filter((prompt) => {
      const haystack = `${prompt.name}\n${prompt.content}\n${prompt.scope}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [prompts, search]);
  const totalPrompts = prompts.length;
  const visiblePrompts = filteredPrompts.length;

  const loadPrompts = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const items = await api.listPrompts(cwd || undefined, "global");
      setPrompts(items);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !content.trim()) return;

    setSaving(true);
    setError("");
    try {
      await api.createPrompt({
        name: name.trim(),
        content: content.trim(),
        scope: "global",
      });
      setName("");
      setContent("");
      await loadPrompts();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deletePrompt(id);
      await loadPrompts();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSaveEdit() {
    if (!editingId || !editName.trim() || !editContent.trim()) return;
    try {
      await api.updatePrompt(editingId, {
        name: editName.trim(),
        content: editContent.trim(),
      });
      setEditingId(null);
      setEditName("");
      setEditContent("");
      await loadPrompts();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Saved Prompts</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Create reusable prompts and insert them quickly with <span className="text-cc-fg">@title</span> in the composer.
            </p>
            <p className="mt-1.5 text-xs text-cc-muted">
              {visiblePrompts} visible / {totalPrompts} total • scope: global
            </p>
          </div>
          {!embedded && (
            <button
              onClick={() => {
                if (currentSessionId) {
                  navigateToSession(currentSessionId);
                } else {
                  navigateHome();
                }
              }}
              className="px-3 py-1.5 rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Back
            </button>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <form onSubmit={handleCreate} className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-4 h-fit">
            <h2 className="text-sm font-semibold text-cc-fg">Create Prompt</h2>
            <div>
              <label className="block text-sm font-medium mb-1.5" htmlFor="prompt-name">
                Title
              </label>
              <input
                id="prompt-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="review-pr"
                className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5" htmlFor="prompt-content">
                Content
              </label>
              <textarea
                id="prompt-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Review this PR and summarize risks, regressions, and missing tests."
                rows={8}
                className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60 resize-y"
              />
            </div>

            <p className="text-xs text-cc-muted">Saved in <code>~/.companion/prompts.json</code></p>

            {error && (
              <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
                {error}
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving || !name.trim() || !content.trim()}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  saving || !name.trim() || !content.trim()
                    ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                    : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                }`}
              >
                {saving ? "Saving..." : "Create Prompt"}
              </button>
            </div>
          </form>

          <div className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 mb-3">
              <h2 className="text-sm font-semibold text-cc-fg">Existing Prompts</h2>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by title or content..."
                className="sm:ml-auto w-full sm:max-w-sm px-3 py-2 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
              />
            </div>
            {loading ? (
              <p className="text-xs text-cc-muted">Loading prompts...</p>
            ) : prompts.length === 0 ? (
              <p className="text-xs text-cc-muted">No prompts yet.</p>
            ) : filteredPrompts.length === 0 ? (
              <p className="text-xs text-cc-muted">No prompts match your search.</p>
            ) : (
              <div className="space-y-2">
                {filteredPrompts.map((prompt) => (
                  <div
                    key={prompt.id}
                    className="border border-cc-border rounded-lg px-3 py-2.5 bg-cc-input-bg/40"
                  >
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium text-cc-fg truncate">{prompt.name}</div>
                      <span className="text-[10px] uppercase tracking-wide text-cc-muted border border-cc-border rounded px-1.5 py-0.5">
                        {prompt.scope}
                      </span>
                      <button
                        onClick={() => {
                          setEditingId(prompt.id);
                          setEditName(prompt.name);
                          setEditContent(prompt.content);
                        }}
                        className="ml-auto text-xs text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => void handleDelete(prompt.id)}
                        className="text-xs text-cc-muted hover:text-cc-error transition-colors cursor-pointer"
                      >
                        Delete
                      </button>
                    </div>
                    {editingId === prompt.id ? (
                      <div className="mt-2 space-y-2">
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="Prompt title"
                          className="w-full px-2.5 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-md text-cc-fg focus:outline-none focus:border-cc-primary/60"
                        />
                        <textarea
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          rows={5}
                          className="w-full px-2.5 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-md text-cc-fg focus:outline-none focus:border-cc-primary/60 resize-y"
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => {
                              setEditingId(null);
                              setEditName("");
                              setEditContent("");
                            }}
                            className="px-2.5 py-1.5 text-xs rounded-md border border-cc-border text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => void handleSaveEdit()}
                            disabled={!editName.trim() || !editContent.trim()}
                            className={`px-2.5 py-1.5 text-xs rounded-md transition-colors ${
                              editName.trim() && editContent.trim()
                                ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                                : "bg-cc-hover text-cc-muted cursor-not-allowed"
                            }`}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-cc-muted whitespace-pre-wrap">{prompt.content}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
